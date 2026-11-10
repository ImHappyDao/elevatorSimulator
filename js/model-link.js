// model-link.js — 아두이노 모형과의 시리얼 통신 (전송, 수신 처리, 연결·끊김, HOME).
// 연결 버튼 등과의 연결(onclick 지정)은 main.js에서 한다.

// ---- 시리얼 ----
const sendLine = (text) => {
	if (!serialWriter) return;
	addLog("→ " + text);
	serialWriter.write(text + "\n").catch(() => {});
};

// 켜진 호출 버튼을 비트마스크로 만든다
const callMask = () =>
	CALL_BUTTONS.reduce(
		(bits, [floor, direction], index) =>
			bits |
			(state.calls.some(
				(call) => call.floor == floor && call.direction == direction,
			)
				? 1 << index
				: 0),
		0,
	);

// 모형에게 floorNumber층(1~5)으로 가라고 지시. 시간이 멈춘 상태면 도착(ARR)까지 시작 버튼을 막는다.
function sendGo(floorNumber) {
	if (!serialWriter || !modelReady) return;
	sendLine("GO " + floorNumber);
	lastGoFloor = floorNumber - 1;
	if (!running) waitingFloor = floorNumber;
}

// 층당·가속 시간을 "실제 시간(ms)"으로 환산해서 전송 (값이 바뀔 때만)
function sendConfig() {
	const floorMs = Math.round((params.floorTime / params.speedMult) * 1000),
		accelMs = Math.round((params.accelTime / params.speedMult) * 1000),
		text = floorMs + " " + accelMs;
	if (text === lastConfig) return;
	sendLine("CFG " + text);
	lastConfig = text;
	requestedFloorMs = floorMs;
}

// 매 프레임 호출: LED, 속도 설정, 정차 층을 모형과 맞춘다
function syncModel() {
	if (!serialWriter || !modelReady) return;
	const ledMask = callMask();
	if (ledMask !== lastLedMask) {
		sendLine("LED " + ledMask);
		lastLedMask = ledMask;
	}
	sendConfig();
	if (running && state.direction && !state.stopLeft) {
		const stopFloor = nextStopFloor(state);
		if (stopFloor !== null && stopFloor !== lastGoFloor) sendGo(stopFloor + 1);
	} else if (running) lastGoFloor = -1;
}

// 아두이노에서 온 한 줄 처리
function handleMessage(line) {
	addLog("← " + line);
	const [command, arg] = line.split(" ");
	if (command == "READY" || command == "HOMED") {
		// 원점을 잡았으니 모형은 1층에 있다: 설정을 보내고 시뮬레이션 위치로 보낸다
		modelReady = true;
		lastConfig = "";
		lastLedMask = -1;
		sendConfig();
		sendGo(Math.round(state.position) + 1);
	} else if (command == "ARR") {
		if (+arg == waitingFloor) waitingFloor = 0;
	} else if (command == "CFGACK") {
		if (requestedFloorMs && +arg > requestedFloorMs * 1.05)
			addLog(
				`⚠ 모형이 요청 속도를 못 따라가요 (요청 ${requestedFloorMs}ms/층, 가능 ${arg}ms/층). 배속 상한을 낮추세요.`,
			);
	} else if (command == "ERR") {
		if (arg == "NOT_HOMED") modelReady = false;
	}
}

// 배속 선택 상자는 정해진 값(1, 2, 4, ...)만 가지므로, 상한을 넘는 값이면
// 상한 이하에서 가장 큰 선택지로 되돌린다
function limitSpeedMultForModel() {
	const select = byId("speedMult");
	if (+select.value <= MODEL_MAX_SPEED_MULT) return;
	const allowed = [...select.options]
		.map((option) => +option.value)
		.filter((value) => value <= MODEL_MAX_SPEED_MULT);
	if (!allowed.length) return;
	select.value = Math.max(...allowed);
	addLog(
		`모형 연결 중에는 배속 상한이 ${MODEL_MAX_SPEED_MULT}배예요 (${select.value}배로 낮춤)`,
	);
}

function onDisconnect() {
	if (!serialWriter) return;
	serialWriter = null;
	modelReady = false;
	waitingFloor = 0;
	lastGoFloor = -1;
	lastLedMask = -1;
	lastConfig = "";
	byId("portConnector").textContent = connectButtonLabel;
	byId("portConnector").classList.remove("ok");
	byId("portConnectStatus").textContent = "연결 끊김";
	addLog("시리얼 연결 종료");
}

// 포트와 연결하는 버튼(portConnector) 클릭 시 포트 연결 요청
// 연결 상태를 portConnectStatus에 출력(연결 중, 연결 실패, 미지원)
async function connectSerial() {
	if (serialWriter) return; // 이미 연결됨

	// 브라우저가 serial을 지원하지 않는 경우
	if (!("serial" in navigator)) {
		byId("portConnectStatus").textContent =
			"이 브라우저는 Web Serial 미지원 (Chrome/Edge 필요)";
		return;
	}

	try {
		// 포트를 연결할지 팝업으로 설정
		const port = await navigator.serial.requestPort();
		await port.open({ baudRate: 115200 });

		const encoder = new TextEncoderStream();
		encoder.readable.pipeTo(port.writable);
		serialWriter = encoder.writable.getWriter();

		// 연결 직후에는 보드가 원점을 잡는 중이므로 READY를 받기 전까지 명령을 보내지 않는다
		modelReady = false;
		waitingFloor = 0;
		lastGoFloor = -1;
		lastLedMask = -1;
		lastConfig = "";

		// 연결이 되면 portConnector에서 연결이 완료됨을 직접 표시
		byId("portConnector").textContent = "모형 연결됨";
		byId("portConnector").classList.add("ok");
		byId("portConnectStatus").textContent = "연결됨 · 모형 준비 중";
		addLog("시리얼 연결");

		limitSpeedMultForModel();

		// 보드가 리셋되지 않는 경우를 대비해 READY가 없으면 상태를 물어본다
		setTimeout(() => {
			if (serialWriter && !modelReady) sendLine("PING");
		}, 2500);

		const reader = port.readable
			.pipeThrough(new TextDecoderStream())
			.getReader();
		let buffer = ""; // 아두이노로부터 받은 데이터를 전송 받은 buffer

		// 이후 '\n'에 맞게 buffer를 변경하며 받은 데이터를 처리
		(async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();

					if (done) break;

					buffer += value;

					let newlineIndex;

					while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
						const line = buffer.slice(0, newlineIndex).trim();
						buffer = buffer.slice(newlineIndex + 1);
						if (line) handleMessage(line);
					}
				}
			} catch (error) {
				addLog("수신 오류: " + (error.message || error));
			} finally {
				onDisconnect();
			}
		})();
	} catch (error) {
		// 연결 실패 시 오류 메시지 출력
		byId("portConnectStatus").textContent =
			"연결 실패: " +
			(error.message || error) +
			" (미리보기 안에서는 막힐 수 있어요)";
	}
}

function requestHome() {
	if (!serialWriter) {
		addLog("모형이 연결되어 있지 않아요");
		return;
	}
	if (running) {
		addLog("시간이 멈춘 상태에서만 HOME을 보낼 수 있어요");
		return;
	}
	modelReady = false; // HOMED를 받으면 다시 준비 완료
	sendLine("HOME");
	addLog("→ HOME");
}

// 모형 연결 중에는 배속 상한을 넘기지 못하게 한다
function onSpeedMultChange() {
	if (serialWriter) limitSpeedMultForModel();
}
