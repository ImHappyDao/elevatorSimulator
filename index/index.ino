/*
 * 엘리베이터 모형 (Arduino + 28BYJ-48 + ULN2003 + 1층 리밋 스위치)
 *
 * 통신: 115200 baud, 줄바꿈('\n') 단위 텍스트, 층 번호는 1~5
 *
 *  PC -> 보드
 *    CFG <층당ms> <가속ms>  이동 속도 설정. 이동 중이면 정차 후에 적용
 *    GO <층>                해당 층에서 멈추도록 이동. 이동 중에도 다시 보낼 수 있음
 *    HOME                   리밋 스위치로 원점(1층) 다시 잡기
 *    LED <마스크>           호출 LED (USE_LEDS 1일 때만 동작)
 *    PING                   상태 확인 (원점이 잡혀 있으면 READY)
 *
 *  보드 -> PC
 *    READY            부팅 후 원점 잡기 완료
 *    HOMED            HOME 명령 후 원점 잡기 완료
 *    ARR <층>         도착 (정지)
 *    CFGACK <층당ms>  실제 적용된 층당 이동 시간 (모터 한계로 요청보다 느릴 수 있음)
 *    ERR <사유>       NOT_HOMED, BAD_FLOOR, BAD_ARG, UNKNOWN, LIMIT, HOME_FAIL
 */

#include <AccelStepper.h>

// ================= 제작 후 조정할 상수 =================

const int FLOORS = 5;						// 층수
const float FLOOR_HEIGHT_MM = 75; 		// 층 높이[단위: mm]

// 줄을 감는 원통 지름[단위: mm] (미정, 정해지면 수정. 현재는 400mm 기준 정함.)
// 지름의 값은 엘리베이터의 이동 거리에 비례하므로 이에 맞추면 된다.
// 만약 최대 실제 이동거리(1F -> 5F)가 450mm면 이 값에 450/400을 곱하면 된다.
const float SPOOL_DIAMETER_MM = 12.73f;

const float STEPS_PER_REV = 4076.0;			// 28BYJ-48 하프스텝 기준 (기어비 63.68395 x 64)
const float MAX_STEPS_PER_SEC = 700.0;		// 모터가 안정적으로 낼 수 있는 속도 (측정 후 수정)
const int UP_SIGN = 1;						// 위로 올라갈 때 스텝 부호 (반대로 움직이면 -1)

const long HOME_OFFSET_STEPS = 0;			// 스위치가 눌리는 위치에서 1층 위치까지 올라가는 스텝 수
const float HOME_SPEED = 300.0;				// 원점 잡을 때 속도 (steps/s)
const long LIMIT_MARGIN_STEPS = 30;			// 1층 아래로 이 이상 내려가 스위치가 눌리면 이상으로 판단
const bool RELEASE_COILS_WHEN_IDLE = false; // 정지 시 코일 전류 차단 (발열 줄임, 카가 내려갈 수 있음)

const uint8_t LIMIT_PIN = A2; 				// C는 이 핀(A2)에, NO는 GND (INPUT_PULLUP / KW-10R 기준)
// ULN2003 IN1~IN4 = 8, 9, 10, 11 (AccelStepper는 IN1, IN3, IN2, IN4 순서로 넘김)
AccelStepper stepper(AccelStepper::HALF4WIRE, 8, 10, 9, 11);

// 호출 LED를 달면 USE_LEDS를 1로. 순서: 1▲ 2▲ 2▼ 3▲ 3▼ 4▲ 4▼ 5▼
#define USE_LEDS 0
#if USE_LEDS
const uint8_t LED_PINS[8] = {2, 3, 4, 5, 6, 7, A0, A1};
#endif
// ======================================================

long stepsPerFloor;
bool homed = false;
bool wasMoving = false;
int pendingFloor = 0; // 감속 후 이어서 갈 층 (0이면 없음)
long cfgFloorMs = 6500, cfgAccelMs = 2000;
bool cfgPending = false; // 이동 중 받은 CFG를 정지 후에 적용
float curAccel = 100.0;

char lineBuf[32];
uint8_t lineLen = 0;

long logicalPos() { return UP_SIGN * stepper.currentPosition(); } // 이론상 위치 값. 1층을 0으로 잡고, 위로는 +, 아래는 -
void moveToLogical(long p) { stepper.moveTo(UP_SIGN * p); }
bool limitPressed() { return digitalRead(LIMIT_PIN) == LOW; } // 원점에 도달했는가? (리밋 스위치가 눌렸는가?)

// 현재 위치해 있는 층을 구하는 함수
int currentFloor()
{
	int f = (int)((logicalPos() + stepsPerFloor / 2) / stepsPerFloor) + 1;
	return constrain(f, 1, FLOORS);
}

// 도착 메시지와 도착한 층을 전달
void sendArr()
{
	Serial.print(F("ARR "));
	Serial.println(currentFloor());
}

// 층당 시간(ms)과 가속 시간(ms)을 속도·가속도로 변환해 적용
void applyCfg(bool ack)
{
	float v = stepsPerFloor / (cfgFloorMs / 1000.0f);
	if (v > MAX_STEPS_PER_SEC)
		v = MAX_STEPS_PER_SEC;
	float accelSec = max(cfgAccelMs, 20L) / 1000.0f;
	curAccel = v / accelSec;
	stepper.setMaxSpeed(v);
	stepper.setAcceleration(curAccel);
	cfgPending = false;
	if (ack)
	{
		Serial.print(F("CFGACK "));
		Serial.println((long)(stepsPerFloor / v * 1000.0f));
	}
}

// ---- 원점 잡기 ----
bool runUntil(float speed, bool wantPressed, long maxSteps)
{
	stepper.setSpeed(speed);
	long n = 0;
	while (limitPressed() != wantPressed)
	{
		if (stepper.runSpeed() && ++n > maxSteps)
			return false;
	}
	return true;
}

// 원점을 잡아 1층으로 이동하는 메소드. 성공적으로 진행하면 true, 아니면 false를 반환함
bool doHome()
{
	Serial.println("Trying to catch the home...");
	homed = false;
	pendingFloor = 0;
	wasMoving = false;

	long maxSteps = (long)(FLOORS + 1) * stepsPerFloor;
	float up = UP_SIGN * HOME_SPEED;

	stepper.setMaxSpeed(HOME_SPEED);
	stepper.setAcceleration(500);

	// 리밋 스위치까지 이동하여 원점 잡기
	if (limitPressed() && !runUntil(up, false, maxSteps))
		return false; // 눌려 있으면 위로 풀기

	if (!runUntil(-up, true, maxSteps))
		return false; // 내려가며 스위치 감지
	
	// 이론상 현 위치를 0으로 잡고, 1층으로 이동
	stepper.setCurrentPosition(0);
	moveToLogical(HOME_OFFSET_STEPS); // 1층 위치까지 올라가기
	stepper.runToPosition();
	stepper.setCurrentPosition(0);
	homed = true;
	applyCfg(false);
	return true;
}

void homeAndReport(bool boot)
{
	if (doHome())
		Serial.println(boot ? F("READY") : F("HOMED"));
	else
		Serial.println(F("ERR HOME_FAIL"));
}

// ---- 이동 ----
void requestMove(int f)
{
	long tgt = (long)(f - 1) * stepsPerFloor;

	if (!stepper.isRunning())
	{ // 정지 상태: 바로 이동
		pendingFloor = 0;
		if (tgt == logicalPos())
		{
			sendArr();
			return;
		}
		moveToLogical(tgt);
		wasMoving = true;
		return;
	}

	// 이동 중 재지정
	long cur = logicalPos();
	int dir = (UP_SIGN * stepper.distanceToGo() >= 0) ? 1 : -1;
	if ((tgt - cur) * dir > 0)
	{					  // 진행 방향 앞쪽이면 목표만 바꿈
		pendingFloor = 0; // (감속 거리보다 가까우면 AccelStepper가 약간 넘어갔다 돌아옴)
		moveToLogical(tgt);
		return;
	}
	// 반대 방향이거나 이미 지난 층: 감속해서 가까운 층에 선 뒤 이어서 이동
	float v = fabs(stepper.speed());
	long decel = (long)(v * v / (2.0f * curAccel)) + 1;
	long stopPos = cur + dir * decel;
	long fl = (dir > 0) ? ((stopPos + stepsPerFloor - 1) / stepsPerFloor) * stepsPerFloor
						: (stopPos / stepsPerFloor) * stepsPerFloor;
	fl = constrain(fl, 0L, (long)(FLOORS - 1) * stepsPerFloor);
	moveToLogical(fl);
	pendingFloor = f;
}

// 이동 후 정지했을 때
void onStopped()
{
	wasMoving = false;
	
	// 이어서 갈 층이 있다면 pendingFloor(이후 0으로 리셋) 층으로 이동
	if (pendingFloor)
	{
		int f = pendingFloor;
		pendingFloor = 0;
		requestMove(f);
		return;
	}

	// CFG가 있다면 적용
	if (cfgPending)
		applyCfg(true);
	
	// PC 시뮬레이션에 메시지 전달
	sendArr();
	if (RELEASE_COILS_WHEN_IDLE)
		stepper.disableOutputs();
}

// ---- 명령 처리 ----
long nextInt(long def)
{
	char *t = strtok(NULL, " ");
	return t ? atol(t) : def;
}

void handleLine(char *s)
{
	char *cmd = strtok(s, " ");
	if (!cmd)
		return;

	if (!strcmp(cmd, "GO"))
	{
		int f = (int)nextInt(0);
		if (!homed)
		{
			Serial.println(F("ERR NOT_HOMED"));
			return;
		}
		if (f < 1 || f > FLOORS)
		{
			Serial.println(F("ERR BAD_FLOOR"));
			return;
		}
		if (RELEASE_COILS_WHEN_IDLE)
			stepper.enableOutputs();
		requestMove(f);
	}
	else if (!strcmp(cmd, "CFG"))
	{
		long fm = nextInt(0), am = nextInt(0);
		if (fm <= 0 || am <= 0)
		{
			Serial.println(F("ERR BAD_ARG"));
			return;
		}
		cfgFloorMs = fm;
		cfgAccelMs = am;
		if (stepper.isRunning())
			cfgPending = true; // 정차 후 적용
		else
			applyCfg(true);
	}
	else if (!strcmp(cmd, "HOME"))
	{
		homeAndReport(false);
	}
	else if (!strcmp(cmd, "LED"))
	{
#if USE_LEDS
		long m = nextInt(0);
		for (uint8_t i = 0; i < 8; i++)
			digitalWrite(LED_PINS[i], (m >> i) & 1);
#endif
	}
	else if (!strcmp(cmd, "PING"))
	{
		Serial.println(homed ? F("READY") : F("ERR NOT_HOMED"));
	}
	else
	{
		Serial.println(F("ERR UNKNOWN"));
	}
}

// 시리얼로 받은 메시지를 버퍼로 처리
void readSerial()
{
	while (Serial.available())
	{
		char c = Serial.read();
		if (c == '\n' || c == '\r')
		{
			if (lineLen)
			{
				lineBuf[lineLen] = 0;
				handleLine(lineBuf);
				lineLen = 0;
			}
		}
		else if (lineLen < sizeof(lineBuf) - 1)
		{
			lineBuf[lineLen++] = c;
		}
		else
		{
			lineLen = 0; // 너무 긴 줄은 버림
		}
	}
}

void setup()
{
	Serial.begin(115200);
	Serial.println(F("Connected Successfully"));
	pinMode(LIMIT_PIN, INPUT_PULLUP);

	// LED를 사용한다면 순서대로 핀번호 지정
#if USE_LEDS
	for (uint8_t i = 0; i < 8; i++)
		pinMode(LED_PINS[i], OUTPUT);
#endif

	stepsPerFloor = lround(FLOOR_HEIGHT_MM / (PI * SPOOL_DIAMETER_MM) * STEPS_PER_REV);
	homeAndReport(true);
}

void loop()
{
	readSerial();
	stepper.run();
	bool moving = stepper.isRunning(); // 움직이면 true, 그렇지 않으면 false

	// 리밋 스위치가 눌려져 있는데도 원점 근처가 아닌 경우
	// 즉, 원점에 있어야하는데 그렇지 않아 오차 범위를 벗어난 경우
	if (limitPressed() && moving && logicalPos() > -HOME_OFFSET_STEPS + LIMIT_MARGIN_STEPS)
	{
		stepper.setCurrentPosition(stepper.currentPosition());
		Serial.println(F("ERR LIMIT"));
		homeAndReport(false);
		return;
	}

	if (wasMoving && !moving)
		onStopped();
	else
		wasMoving = moving;
}
