// homing.ino — 원점 잡기. 엘리베이터별 상태머신이라 loop()가 두 대를 번갈아 처리한다.
// 한 번에 한 대만 원점을 잡고(A → B 순서), 나머지는 계속 운행한다.
// 원점이 잡히지 않은 엘리베이터에 GO를 보내면 ERR <엘리베이터> NOT_HOMED로 거부한다.

// 원점 잡기를 요청한다. 움직이는 중이면 바로 멈추고, 실제 시작은 다른 대의 원점 잡기가 끝난 뒤.
void queueHome(uint8_t i, bool boot)
{
	Elevator &e = elevs[i];
	if (e.homeState != H_NONE || e.homeQueued)
		return; // 이미 진행 중이거나 대기 중
	e.stepper.setCurrentPosition(e.stepper.currentPosition()); // 즉시 정지
	e.homed = false;
	e.pendingFloor = 0;
	e.wasMoving = false;
	e.homeQueued = true;
	e.homeBoot = boot;
}

// 한 대도 원점을 잡고 있지 않으면, 대기 중인 첫 번째(A → B)를 시작한다
void startNextHome()
{
	for (uint8_t i = 0; i < NUM_ELEV; i++)
		if (elevs[i].homeState != H_NONE)
			return;

	for (uint8_t i = 0; i < NUM_ELEV; i++)
	{
		Elevator &e = elevs[i];
		if (!e.homeQueued)
			continue;

		Serial.println(F("Trying to catch the home..."));
		e.homeQueued = false;
		e.homed = false;
		e.pendingFloor = 0;
		e.wasMoving = false;
		e.homeSteps = 0;

		float up = UP_SIGN * HOME_SPEED;
		e.stepper.setMaxSpeed(HOME_SPEED);
		e.stepper.setAcceleration(500);

		if (limitPressed(i))
		{ // 눌려 있으면 위로 풀기
			e.homeState = H_RELEASE;
			e.stepper.setSpeed(up);
		}
		else
		{ // 내려가며 스위치 감지
			e.homeState = H_SEEK;
			e.stepper.setSpeed(-up);
		}
		return;
	}
}

void homeFail(uint8_t i)
{
	Elevator &e = elevs[i];
	e.stepper.setCurrentPosition(e.stepper.currentPosition());
	e.homeState = H_NONE;
	e.homed = false;
	sendErr(i, F("HOME_FAIL"));
}

void homeDone(uint8_t i)
{
	Elevator &e = elevs[i];
	e.stepper.setCurrentPosition(0);
	e.homeState = H_NONE;
	e.homed = true;
	applyCfg(i, e.cfgPending); // 원점 잡는 동안 받은 CFG가 있으면 이때 적용하고 응답
	sendMsg(e.homeBoot ? F("READY") : F("HOMED"), i);
}

// loop()에서 매번 호출: 원점을 잡는 중인 엘리베이터를 한 걸음 진행
void updateHome(uint8_t i)
{
	Elevator &e = elevs[i];
	long maxSteps = (long)(FLOORS + 1) * stepsPerFloor;
	float up = UP_SIGN * HOME_SPEED;

	if (e.homeState == H_RELEASE)
	{
		if (!limitPressed(i))
		{
			e.homeState = H_SEEK;
			e.homeSteps = 0;
			e.stepper.setSpeed(-up);
			return;
		}
		if (e.stepper.runSpeed() && ++e.homeSteps > maxSteps)
			homeFail(i);
	}
	else if (e.homeState == H_SEEK)
	{
		if (limitPressed(i))
		{ // 이론상 현 위치를 0으로 잡고, 1층으로 이동
			e.stepper.setCurrentPosition(0);
			moveToLogical(i, HOME_OFFSET_STEPS); // 1층 위치까지 올라가기
			e.homeState = H_OFFSET;
			return;
		}
		if (e.stepper.runSpeed() && ++e.homeSteps > maxSteps)
			homeFail(i);
	}
	else if (e.homeState == H_OFFSET)
	{
		if (e.stepper.run())
			return;
		homeDone(i);
	}
}
