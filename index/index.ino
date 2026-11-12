/*
 * 엘리베이터 모형 2대 (Arduino + 28BYJ-48 x2 + ULN2003 x2 + 1층 리밋 스위치 x2)
 *
 * 파일 구성 (Arduino IDE는 이 폴더의 파일을 하나로 합쳐 컴파일한다)
 *   index.ino     setup(), loop()
 *   config.h      상수, 핀, Elevator 구조체, 전역 변수 (여기서만 include)
 *   motion.ino    위치·층 계산, 속도 설정(CFG), 이동(GO), 정지 처리
 *   homing.ino    원점 잡기 상태머신 (loop()에서 두 대를 번갈아 처리)
 *   protocol.ino  PC와의 시리얼 통신 (명령 파싱·실행, 응답 전송)
 *
 * 통신 규약은 protocol.ino 맨 위 주석 참고.
 */

#include "config.h"

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
