/*
 * protocol.ino — PC와의 시리얼 통신 (응답 전송, 명령 파싱·실행)
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
 */

char lineBuf[32];
uint8_t lineLen = 0;

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
