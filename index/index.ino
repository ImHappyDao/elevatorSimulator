/*
 * 엘리베이터 모형 2대 (Arduino + 28BYJ-48 x2 + ULN2003 x2 + 1층 리밋 스위치 x2)
 *
 * 통신: 115200 baud, 줄바꿈('\n') 단위 텍스트, 층 번호는 1~5
 * 모든 명령은 <명령> <엘리베이터> <파라미터...> 형식이다.
 * 엘리베이터: A, B, ALL (대문자만. ALL이면 A → B 순서로 각각 처리하고 응답도 각각 보냄)
 *
 *  PC -> 보드
 *    CFG <엘리베이터> <층당ms> <가속ms>  이동 속도 설정. 이동 중이면 정차 후에 적용
 *    GO <엘리베이터> <층>                 해당 층에서 멈추도록 이동. 이동 중에도 다시 보낼 수 있음
 *    HOME <엘리베이터>                    리밋 스위치로 원점(1층) 다시 잡기 (다른 엘리베이터는 멈추지 않음)
 *    LED <엘리베이터> <마스크>            호출 LED (USE_LEDS 1일 때만 동작)
 *    PING <엘리베이터>                    상태 확인 (원점이 잡혀 있으면 READY)
 *
 *  보드 -> PC (모두 엘리베이터 식별자 포함)
 *    READY <엘리베이터>                   부팅 후 원점 잡기 완료
 *    HOMED <엘리베이터>                   HOME 명령 후 원점 잡기 완료
 *    ARR <엘리베이터> <층>                도착 (정지)
 *    CFGACK <엘리베이터> <층당ms>         실제 적용된 층당 이동 시간 (모터 한계로 요청보다 느릴 수 있음)
 *    ERR <엘리베이터> <사유>              NOT_HOMED, BAD_FLOOR, BAD_ARG, BAD_ELEV, UNKNOWN, LIMIT, HOME_FAIL
 *                                         엘리베이터 자리에는 받은 토큰을 그대로 돌려줌 (없으면 '-')
 *
 * 원점 잡기는 엘리베이터별 상태머신이라 loop()가 두 대를 번갈아 처리한다.
 * 한 번에 한 대만 원점을 잡고(A → B 순서), 나머지는 계속 운행한다.
 * 원점이 잡히지 않은 엘리베이터에 GO를 보내면 ERR <엘리베이터> NOT_HOMED로 거부한다.
 */

#include <AccelStepper.h>

// ================= 제작 후 조정할 상수 (두 엘리베이터 공통) =================

const uint8_t NUM_ELEV = 2;					// 엘리베이터 수 (A, B)
const int FLOORS = 5;						// 층수
const float FLOOR_HEIGHT_MM = 75; 			// 층 높이[단위: mm]

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

// 호출 LED를 달면 USE_LEDS를 1로. 순서: 1▲ 2▲ 2▼ 3▲ 3▼ 4▲ 4▼ 5▼
// 주의: LED는 엘리베이터 구분 없이 기존 동작 그대로이고, 아래 핀이 B 모터(4~7)와 겹친다.
//       켜기 전에 핀을 다시 배정해야 한다.
#define USE_LEDS 0
#if USE_LEDS
const uint8_t LED_PINS[8] = {2, 3, 4, 5, 6, 7, A0, A1};
#endif
// ======================================================

// 원점 잡기 단계
const uint8_t H_NONE = 0;	  // 원점 잡는 중 아님
const uint8_t H_RELEASE = 1; // 스위치가 눌려 있어서 위로 올려 푸는 중
const uint8_t H_SEEK = 2;	  // 내려가며 스위치를 찾는 중
const uint8_t H_OFFSET = 3;	  // 스위치 위치에서 1층 위치까지 올라가는 중

// 엘리베이터 한 대의 모터·스위치·상태
struct Elevator
{
	AccelStepper stepper;
	uint8_t limitPin; // C는 이 핀에, NO는 GND (INPUT_PULLUP / KW-10R 기준)
	char id;		  // 'A' 또는 'B'

	bool homed;
	bool wasMoving;
	int pendingFloor; // 감속 후 이어서 갈 층 (0이면 없음)
	long cfgFloorMs, cfgAccelMs;
	bool cfgPending; // 이동 중 받은 CFG를 정지 후에 적용
	float curAccel;

	uint8_t homeState; // H_NONE, H_RELEASE, H_SEEK, H_OFFSET
	bool homeQueued;   // 원점 잡기 대기 중 (한 번에 한 대만 진행)
	bool homeBoot;	   // 부팅 때의 원점 잡기인가 (READY / HOMED 구분)
	long homeSteps;	   // 원점 잡는 동안 이동한 스텝 수 (안전장치)

	// ULN2003 IN1~IN4를 순서대로 받는다 (AccelStepper는 IN1, IN3, IN2, IN4 순서로 넘김)
	Elevator(uint8_t in1, uint8_t in2, uint8_t in3, uint8_t in4, uint8_t limit, char name)
		: stepper(AccelStepper::HALF4WIRE, in1, in3, in2, in4), limitPin(limit), id(name),
		  homed(false), wasMoving(false), pendingFloor(0), cfgFloorMs(6500), cfgAccelMs(2000),
		  cfgPending(false), curAccel(100.0f), homeState(H_NONE), homeQueued(false),
		  homeBoot(false), homeSteps(0) {}
};

// A: 모터 IN1~4 = 8, 9, 10, 11 / 리밋 A2
// B: 모터 IN1~4 = 4, 5, 6, 7   / 리밋 A3
Elevator elevs[NUM_ELEV] = {
	Elevator(8, 9, 10, 11, A2, 'A'),
	Elevator(4, 5, 6, 7, A3, 'B'),
};

long stepsPerFloor;

char lineBuf[32];
uint8_t lineLen = 0;

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

// ---- 응답 전송 ----
// "<메시지> <엘리베이터>"
void sendMsg(const __FlashStringHelper *msg, uint8_t i)
{
	Serial.print(msg);
	Serial.print(' ');
	Serial.println(elevs[i].id);
}

// "<메시지> <엘리베이터> <값>"
void sendMsgVal(const __FlashStringHelper *msg, uint8_t i, long value)
{
	Serial.print(msg);
	Serial.print(' ');
	Serial.print(elevs[i].id);
	Serial.print(' ');
	Serial.println(value);
}

// "ERR <엘리베이터> <사유>"
void sendErr(uint8_t i, const __FlashStringHelper *why)
{
	Serial.print(F("ERR "));
	Serial.print(elevs[i].id);
	Serial.print(' ');
	Serial.println(why);
}

// 엘리베이터를 알아볼 수 없을 때: 받은 토큰을 그대로 돌려준다 (없으면 '-')
void sendErrTok(const char *tok, const __FlashStringHelper *why)
{
	Serial.print(F("ERR "));
	Serial.print(tok ? tok : "-");
	Serial.print(' ');
	Serial.println(why);
}

// 도착 메시지와 도착한 층을 전달
void sendArr(uint8_t i)
{
	sendMsgVal(F("ARR"), i, currentFloor(i));
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

// ---- 원점 잡기 (엘리베이터별 상태머신, loop()에서 조금씩 진행) ----
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

// ---- 명령 처리 ----
// 엘리베이터 토큰을 비트마스크로: A=1, B=2, ALL=3, 잘못된 값=0
uint8_t parseTarget(const char *tok)
{
	if (!tok)
		return 0;
	if (!strcmp(tok, "A"))
		return 1;
	if (!strcmp(tok, "B"))
		return 2;
	if (!strcmp(tok, "ALL"))
		return 3;
	return 0;
}

bool isKnownCmd(const char *cmd)
{
	return !strcmp(cmd, "GO") || !strcmp(cmd, "CFG") || !strcmp(cmd, "HOME") ||
		   !strcmp(cmd, "LED") || !strcmp(cmd, "PING");
}

// 엘리베이터 한 대에 명령 하나를 실행. args는 엘리베이터 토큰 뒤의 숫자 파라미터(최대 2개)
void execCommand(const char *cmd, uint8_t i, const long *args, uint8_t argc)
{
	Elevator &e = elevs[i];

	if (!strcmp(cmd, "GO"))
	{
		if (!e.homed)
		{
			sendErr(i, F("NOT_HOMED"));
			return;
		}
		if (argc < 1)
		{
			sendErr(i, F("BAD_ARG"));
			return;
		}
		int f = (int)args[0];
		if (f < 1 || f > FLOORS)
		{
			sendErr(i, F("BAD_FLOOR"));
			return;
		}
		if (RELEASE_COILS_WHEN_IDLE)
			e.stepper.enableOutputs();
		requestMove(i, f);
	}
	else if (!strcmp(cmd, "CFG"))
	{
		long fm = argc > 0 ? args[0] : 0, am = argc > 1 ? args[1] : 0;
		if (fm <= 0 || am <= 0)
		{
			sendErr(i, F("BAD_ARG"));
			return;
		}
		e.cfgFloorMs = fm;
		e.cfgAccelMs = am;
		if (e.stepper.isRunning() || e.homeState != H_NONE)
			e.cfgPending = true; // 정차(또는 원점 잡기 완료) 후 적용
		else
			applyCfg(i, true);
	}
	else if (!strcmp(cmd, "HOME"))
	{
		queueHome(i, false);
	}
	else if (!strcmp(cmd, "LED"))
	{
#if USE_LEDS
		long m = argc > 0 ? args[0] : 0;
		for (uint8_t k = 0; k < 8; k++)
			digitalWrite(LED_PINS[k], (m >> k) & 1);
#endif
	}
	else if (!strcmp(cmd, "PING"))
	{
		if (e.homed)
			sendMsg(F("READY"), i);
		else
			sendErr(i, F("NOT_HOMED"));
	}
}

void handleLine(char *s)
{
	char *cmd = strtok(s, " ");
	if (!cmd)
		return;
	char *elevTok = strtok(NULL, " ");

	if (!isKnownCmd(cmd))
	{
		sendErrTok(elevTok, F("UNKNOWN"));
		return;
	}

	uint8_t mask = parseTarget(elevTok);
	if (!mask)
	{
		sendErrTok(elevTok, F("BAD_ELEV"));
		return;
	}

	// 숫자 파라미터를 먼저 읽어 두고(최대 2개), ALL이면 같은 값으로 A, B에 각각 실행
	long args[2] = {0, 0};
	uint8_t argc = 0;
	char *t;
	while (argc < 2 && (t = strtok(NULL, " ")))
		args[argc++] = atol(t);

	for (uint8_t i = 0; i < NUM_ELEV; i++)
		if (mask & (1 << i))
			execCommand(cmd, i, args, argc);
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

	// LED를 사용한다면 순서대로 핀번호 지정
#if USE_LEDS
	for (uint8_t k = 0; k < 8; k++)
		pinMode(LED_PINS[k], OUTPUT);
#endif

	stepsPerFloor = lround(FLOOR_HEIGHT_MM / (PI * SPOOL_DIAMETER_MM) * STEPS_PER_REV);

	// 부팅 시 원점은 A → B 순서로 잡는다 (실제 진행은 loop()에서)
	for (uint8_t i = 0; i < NUM_ELEV; i++)
	{
		pinMode(elevs[i].limitPin, INPUT_PULLUP);
		queueHome(i, true);
	}
}

void loop()
{
	readSerial();
	startNextHome();

	for (uint8_t i = 0; i < NUM_ELEV; i++)
	{
		Elevator &e = elevs[i];

		if (e.homeState != H_NONE)
		{ // 원점 잡는 중
			updateHome(i);
			continue;
		}
		if (!e.homed)
			continue; // 원점이 없으면 움직이지 않는다

		e.stepper.run();
		bool moving = e.stepper.isRunning(); // 움직이면 true, 그렇지 않으면 false

		// 리밋 스위치가 눌려져 있는데도 원점 근처가 아닌 경우
		// 즉, 원점에 있어야하는데 그렇지 않아 오차 범위를 벗어난 경우
		if (limitPressed(i) && moving && logicalPos(i) > -HOME_OFFSET_STEPS + LIMIT_MARGIN_STEPS)
		{
			sendErr(i, F("LIMIT"));
			queueHome(i, false); // 이 엘리베이터만 멈추고 다시 원점을 잡는다
			continue;
		}

		if (e.wasMoving && !moving)
			onStopped(i);
		else
			e.wasMoving = moving;
	}
}
