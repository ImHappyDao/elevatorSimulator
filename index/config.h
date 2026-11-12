// config.h — 상수, 핀, 엘리베이터 구조체와 전역 변수.
// 전역 변수가 여기서 정의되므로 index.ino에서 한 번만 include한다.
#pragma once

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
