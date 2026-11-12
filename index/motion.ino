// motion.ino — 위치·층 계산, 속도 설정(CFG), 이동(GO), 정지 처리.
// 함수는 모두 엘리베이터 번호(0=A, 1=B)를 받는다. (Arduino IDE 자동 프로토타입 문제를 피하려고 구조체를 인자로 쓰지 않음)

long logicalPos(uint8_t i) { return UP_SIGN * elevs[i].stepper.currentPosition(); } // 이론상 위치 값. 1층을 0으로 잡고, 위로는 +, 아래는 -
void moveToLogical(uint8_t i, long p) { elevs[i].stepper.moveTo(UP_SIGN * p); }
bool limitPressed(uint8_t i) { return digitalRead(elevs[i].limitPin) == LOW; } // 원점에 도달했는가? (리밋 스위치가 눌렸는가?)

// 현재 위치해 있는 층을 구하는 함수
int currentFloor(uint8_t i)
{
	int f = (int)((logicalPos(i) + stepsPerFloor / 2) / stepsPerFloor) + 1;
	return constrain(f, 1, FLOORS);
}

// 층당 시간(ms)과 가속 시간(ms)을 속도·가속도로 변환해 적용
void applyCfg(uint8_t i, bool ack)
{
	Elevator &e = elevs[i];
	float v = stepsPerFloor / (e.cfgFloorMs / 1000.0f);
	if (v > MAX_STEPS_PER_SEC)
		v = MAX_STEPS_PER_SEC;
	float accelSec = max(e.cfgAccelMs, 20L) / 1000.0f;
	e.curAccel = v / accelSec;
	e.stepper.setMaxSpeed(v);
	e.stepper.setAcceleration(e.curAccel);
	e.cfgPending = false;
	if (ack)
		sendMsgVal(F("CFGACK"), i, (long)(stepsPerFloor / v * 1000.0f));
}

// ---- 이동 ----
void requestMove(uint8_t i, int f)
{
	Elevator &e = elevs[i];
	long tgt = (long)(f - 1) * stepsPerFloor;

	if (!e.stepper.isRunning())
	{ // 정지 상태: 바로 이동
		e.pendingFloor = 0;
		if (tgt == logicalPos(i))
		{
			sendArr(i);
			return;
		}
		moveToLogical(i, tgt);
		e.wasMoving = true;
		return;
	}

	// 이동 중 재지정
	long cur = logicalPos(i);
	int dir = (UP_SIGN * e.stepper.distanceToGo() >= 0) ? 1 : -1;
	if ((tgt - cur) * dir > 0)
	{						// 진행 방향 앞쪽이면 목표만 바꿈
		e.pendingFloor = 0; // (감속 거리보다 가까우면 AccelStepper가 약간 넘어갔다 돌아옴)
		moveToLogical(i, tgt);
		return;
	}
	// 반대 방향이거나 이미 지난 층: 감속해서 가까운 층에 선 뒤 이어서 이동
	float v = fabs(e.stepper.speed());
	long decel = (long)(v * v / (2.0f * e.curAccel)) + 1;
	long stopPos = cur + dir * decel;
	long fl = (dir > 0) ? ((stopPos + stepsPerFloor - 1) / stepsPerFloor) * stepsPerFloor
						: (stopPos / stepsPerFloor) * stepsPerFloor;
	fl = constrain(fl, 0L, (long)(FLOORS - 1) * stepsPerFloor);
	moveToLogical(i, fl);
	e.pendingFloor = f;
}

// 이동 후 정지했을 때
void onStopped(uint8_t i)
{
	Elevator &e = elevs[i];
	e.wasMoving = false;

	// 이어서 갈 층이 있다면 pendingFloor(이후 0으로 리셋) 층으로 이동
	if (e.pendingFloor)
	{
		int f = e.pendingFloor;
		e.pendingFloor = 0;
		requestMove(i, f);
		return;
	}

	// CFG가 있다면 적용
	if (e.cfgPending)
		applyCfg(i, true);

	// PC 시뮬레이션에 메시지 전달
	sendArr(i);
	if (RELEASE_COILS_WHEN_IDLE)
		e.stepper.disableOutputs();
}
