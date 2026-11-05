const byId = (id) => document.getElementById(id);

// 화면 설정값 (입력칸에서 읽어 온다)
const params = {
	floorTime: 6.5, // 한 층을 순항 속도로 지나는 시간(초)
	stopTime: 5, // 한 번 정차했을 때 머무는 시간(초)
	stairUpTime: 10, // 계단으로 한 층 올라가는 시간(초)
	stairDownTime: 6, // 계단으로 한 층 내려가는 시간(초)
	accelTime: 2, // 가속(감속) 시간(초)
	speedMult: 4, // 시뮬레이션 배속
};
// 모형이 연결돼 있을 때의 배속 상한 (모터 한계에 따라 제작 후 측정해서 조정)
const MODEL_MAX_SPEED_MULT = 1.5;
const calcStairTime = (from, to) =>
	Math.abs(to - from) * (to > from ? params.stairUpTime : params.stairDownTime);

// 시드 기반 난수 생성기 (같은 시드면 같은 순서의 난수가 나온다)
function makeRandom(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

let state, // 엘리베이터 시뮬레이션 상태
	random,
	nextCallTime, // 다음 자동 호출이 일어날 시뮬레이션 시각
	autoCallEnabled = false,
	running = false, // 시뮬레이션 시간이 흐르는 중인지
	race = null, // 엘리베이터 vs 계단 경주 정보
	serialWriter = null, // 연결돼 있으면 시리얼 writer
	accumulatedTime = 0, // 아직 처리하지 못한 누적 시뮬레이션 시간
	lastFrameTime = performance.now(),
	lastGoFloor = -1, // 아두이노에 마지막으로 보낸 GO 층(0~4)
	lastLedMask = -1,
	lastConfig = "",
	requestedFloorMs = 0, // 아두이노에 요청한 층당 시간(ms)
	modelReady = false, // 모형이 원점을 잡고 준비됐는지
	waitingFloor = 0, // 모형이 도착하기를 기다리는 층(1~5)
	fromFloor = 1,
	toFloor = 4;

const callGap = () => {
	const min = +byId("callGapMin").value || 5,
		max = Math.max(min, +byId("callGapMax").value || 15);
	return min + random() * (max - min);
};

// 이동 시간·배속(floorTime, accelTime, speedMult)은 시간이 멈췄거나 정차 중일 때만 반영한다.
// 이동 중에 바꾸면 시뮬레이션은 바로 빨라지는데 모형은 그대로라 어긋나기 때문.
const readParams = () => {
	params.stopTime = +byId("stopTime").value || 5;
	params.stairUpTime = +byId("stairUpTime").value || 10;
	params.stairDownTime = +byId("stairDownTime").value || 6;
	if (!running || state.stopLeft > 0 || state.direction == 0) {
		params.floorTime = +byId("floorTime").value || 6.5;
		params.accelTime = +byId("accelTime").value || 2;
		let mult = +byId("speedMult").value || 4;
		if (serialWriter) mult = Math.min(mult, MODEL_MAX_SPEED_MULT);
		params.speedMult = mult;
	}
};

function addLog(message) {
	const line = document.createElement("div");
	line.textContent =
		(state ? state.time.toFixed(0).padStart(3, " ") + "s " : "") + message;
	byId("log").prepend(line);
	while (byId("log").children.length > 80) byId("log").lastChild.remove();
}

// ---- 운행 엔진 (층 0~4, 방향 1=상승 -1=하강 0=대기) ----
// 가야 할 층 목록 (호출한 층 + 탑승자의 목적 층)
const targetFloors = (state) => [
	...state.calls.map((call) => call.floor),
	...state.riders.map((rider) => rider.destFloor),
];

// 진행 방향 앞/뒤에 가야 할 층이 있는지
const hasTargetAhead = (state, floor, direction) =>
		targetFloors(state).some((target) => (target - floor) * direction > 0),
	hasTargetBehind = (state, floor, direction) =>
		targetFloors(state).some((target) => (target - floor) * direction < 0);

const shouldStop = (state, floor, direction) =>
	state.riders.some((rider) => rider.destFloor == floor) ||
	state.calls.some(
		(call) =>
			call.floor == floor &&
			(call.direction == direction || !hasTargetAhead(state, floor, direction)),
	);

function fixDirection(state) {
	const floor = Math.round(state.position);
	if (state.direction && !hasTargetAhead(state, floor, state.direction))
		state.direction = hasTargetBehind(state, floor, state.direction)
			? -state.direction
			: 0;
}

// 정차 처리: 하차 → 방향 결정 → 탑승
function handleStop(state, onEvent) {
	const floor = Math.round(state.position);
	let direction = state.direction,
		acted = false;
	state.riders = state.riders.filter((rider) => {
		if (rider.destFloor == floor) {
			acted = true;
			onEvent && onEvent("drop", floor, rider);
			return false;
		}
		return true;
	});
	if (!hasTargetAhead(state, floor, direction)) {
		const waitingCall = state.calls.find((call) => call.floor == floor);
		if (waitingCall) direction = waitingCall.direction;
		else if (hasTargetBehind(state, floor, direction)) direction = -direction;
		else direction = 0;
	}
	state.calls = state.calls.filter((call) => {
		if (call.floor == floor && call.direction == direction) {
			acted = true;
			call.passengers.forEach((passenger) => {
				onEvent && onEvent("board", floor, passenger);
				if (!(state.noDrop && !passenger.isUser))
					state.riders.push({
						destFloor: passenger.dropFloor,
						isUser: passenger.isUser,
					});
				else state.virtualCount++;
			});
			return false;
		}
		return true;
	});
	if (
		direction != 0 &&
		!hasTargetAhead(state, floor, direction) &&
		!hasTargetBehind(state, floor, direction)
	)
		direction = 0;
	state.direction = direction;
	state.stopLeft = acted ? params.stopTime : 0;
	state.phase = "rest";
}

// 속도 모델: 정지 -> 가속(accelTime초, 선형) -> 순항(층당 floorTime초) -> 감속(accelTime초, 선형) -> 정차(stopTime초)
// 시뮬레이션 시간을 dt초만큼 진행한다
function tick(state, dt, onEvent) {
	state.time += dt;
	if (state.stopLeft > 0) {
		state.stopLeft -= dt;
		if (state.stopLeft <= 0) {
			state.stopLeft = 0;
			fixDirection(state);
		}
		return;
	}
	const floor = Math.round(state.position),
		cruiseSpeed = 1 / params.floorTime, // 층/초
		accelTime = Math.max(0.1, params.accelTime);
	if (state.direction == 0) {
		state.phase = "rest";
		const targets = targetFloors(state);
		if (!targets.length) return;
		if (
			state.calls.some((call) => call.floor == floor) ||
			state.riders.some((rider) => rider.destFloor == floor)
		) {
			handleStop(state, onEvent);
			return;
		}
		state.direction = Math.sign(
			targets.reduce((nearest, target) =>
				Math.abs(target - state.position) < Math.abs(nearest - state.position)
					? target
					: nearest,
			) - state.position,
		);
		return;
	}
	if (!state.phase || state.phase == "rest") {
		state.phase = "acc";
		state.phaseTime = 0;
		state.checkedFloor = null;
	}
	// 진행 방향으로 가장 가까운 다음 층
	const nextFloor =
		state.direction > 0
			? Math.floor(state.position + 1e-9) + 1
			: Math.ceil(state.position - 1e-9) - 1;
	state.phaseTime += dt;
	let speed;
	if (state.phase == "dec") {
		if (state.phaseTime >= accelTime) {
			state.position = state.targetFloor;
			handleStop(state, onEvent);
			return;
		}
		speed = cruiseSpeed * (1 - state.phaseTime / accelTime);
	} else {
		if (state.phase == "acc" && state.phaseTime >= accelTime)
			state.phase = "cruise";
		speed =
			state.phase == "acc"
				? (cruiseSpeed * state.phaseTime) / accelTime
				: cruiseSpeed;
		if (
			state.checkedFloor !== nextFloor &&
			Math.abs(nextFloor - state.position) <=
				(cruiseSpeed * accelTime) / 2 + 1e-9
		) {
			state.checkedFloor = nextFloor;
			if (
				shouldStop(state, nextFloor, state.direction) ||
				!hasTargetAhead(state, nextFloor, state.direction)
			) {
				state.phase = "dec";
				state.phaseTime = 0;
				state.targetFloor = nextFloor;
				speed = cruiseSpeed;
			}
		}
	}
	let newPosition = state.position + state.direction * speed * dt;
	if (state.phase == "dec") {
		if ((newPosition - state.targetFloor) * state.direction > 0)
			newPosition = state.targetFloor;
		state.position = newPosition;
	} else if ((newPosition - nextFloor) * state.direction >= -1e-9) {
		state.position = nextFloor;
		state.checkedFloor = null;
	} else state.position = newPosition;
}

// floor층에서 direction 방향 호출을 추가한다. dropFloor는 이 호출로 탄 사람이 내릴 층
function addCall(state, floor, direction, dropFloor, isUser) {
	let call = state.calls.find(
		(c) => c.floor == floor && c.direction == direction,
	);
	if (!call) {
		call = { floor, direction, passengers: [] };
		state.calls.push(call);
	}
	call.passengers.push({ dropFloor, isUser });
}

// 현재 상태를 복사해서 가상으로 돌려 보고, 사용자가 내릴 때까지 걸리는 시간(초)을 구한다
function estimateElevatorTime(from, to) {
	const copy = JSON.parse(JSON.stringify(state));
	addCall(copy, from, to > from ? 1 : -1, to, true);
	let arrivedAt = null;
	const startTime = copy.time;
	const onEvent = (kind, floor, person) => {
		if (kind == "drop" && person.isUser) arrivedAt = copy.time - startTime;
	};
	for (let i = 0; i < 40000 && arrivedAt === null; i++)
		tick(copy, 0.05, onEvent);
	return arrivedAt;
}

function addRandomCall() {
	const options = [];
	for (let floor = 0; floor < 5; floor++) {
		if (floor < 4) options.push([floor, 1]);
		if (floor > 0) options.push([floor, -1]);
	}
	const [floor, direction] = options[Math.floor(random() * options.length)],
		mode = byId("dropMode").value;
	let dropFloor;
	if (mode == "rule")
		dropFloor = direction > 0 ? Math.min(floor + 2, 4) : Math.max(floor - 2, 0);
	else if (mode == "end") dropFloor = direction > 0 ? 4 : 0;
	else {
		const candidates = [];
		for (let target = 0; target < 5; target++)
			if ((target - floor) * direction > 0) candidates.push(target);
		dropFloor = candidates[Math.floor(random() * candidates.length)];
	}
	addCall(state, floor, direction, dropFloor, false);
	addLog(`호출 ${floor + 1}층${direction > 0 ? "▲" : "▼"}`);
}

// 호출한 층·방향에 맞는 가상 탑승자의 하차 층을 정한다
function pickDropFloor(floor, direction) {
	const mode = byId("dropMode").value;
	if (mode == "rule")
		return direction > 0 ? Math.min(floor + 2, 4) : Math.max(floor - 2, 0);
	if (mode == "end") return direction > 0 ? 4 : 0;
	const candidates = [];
	for (let target = 0; target < 5; target++)
		if ((target - floor) * direction > 0) candidates.push(target);
	return candidates[Math.floor(random() * candidates.length)];
}

// 시간을 멈추고 무작위 초기 상황을 만든다
function newScenario() {
	running = false;
	state.calls = [];
	state.riders = [];
	state.stopLeft = 0;
	state.time = 0;
	race = null;
	nextCallTime = callGap();
	lastGoFloor = -1;
	lastLedMask = -1;
	byId("resultBox").className = "mut";
	byId("resultBox").textContent =
		"출발·도착 층을 고르고 실행하세요. 예상은 이후 새 호출이 없다고 가정한 값이에요.";
	const floor = Math.floor(random() * 5);
	let direction = random() < 0.5 ? 1 : -1;
	if (floor == 0) direction = 1;
	if (floor == 4) direction = -1;
	state.position = floor;
	state.direction = direction;
	// 모형은 정지 상태에서 출발하므로 시뮬레이션도 정지(rest)에서 가속부터 시작한다
	state.phase = "rest";
	state.phaseTime = 0;
	state.checkedFloor = null;
	CALL_BUTTONS.forEach(([callFloor, callDirection]) => {
		if (!(callFloor == floor && callDirection == direction) && random() < 0.4)
			addCall(
				state,
				callFloor,
				callDirection,
				pickDropFloor(callFloor, callDirection),
				false,
			);
	});
	if (!hasTargetAhead(state, floor, direction)) {
		const candidates = [];
		for (let target = 0; target < 5; target++)
			if ((target - floor) * direction > 0) candidates.push(target);
		const extraFloor = candidates[Math.floor(random() * candidates.length)],
			extraDirection =
				extraFloor == 4 ? -1 : extraFloor == 0 ? 1 : random() < 0.5 ? 1 : -1;
		addCall(state, extraFloor, extraDirection, 0, false);
	}
	state.virtualCount = Math.floor(random() * 4);
	sendGo(floor + 1);
	addLog(
		`새 상황: 엘리베이터 ${floor + 1}층 ${direction > 0 ? "상승" : "하강"} 중 · 호출 ${state.calls.map((call) => call.floor + 1 + (call.direction > 0 ? "▲" : "▼")).join(" ") || "없음"}`,
	);
}

function toggleCall(floor, direction) {
	const index = state.calls.findIndex(
		(call) => call.floor == floor && call.direction == direction,
	);
	if (index >= 0) {
		if (state.calls[index].passengers.some((passenger) => passenger.isUser))
			return;
		state.calls.splice(index, 1);
		addLog(`호출 취소 ${floor + 1}층${direction > 0 ? "▲" : "▼"}`);
	} else {
		addCall(state, floor, direction, 0, false);
		addLog(`호출 ${floor + 1}층${direction > 0 ? "▲" : "▼"}`);
	}
}

function moveCarTo(floor) {
	if (running) return;
	state.position = floor;
	state.stopLeft = 0;
	state.phase = "rest";
	state.checkedFloor = null;
	state.direction = floor == 0 ? 1 : floor == 4 ? -1 : state.direction || 1;
	lastGoFloor = -1;
	sendGo(floor + 1);
	addLog(`엘리베이터 ${floor + 1}층으로 이동`);
}

function flipDirection() {
	if (running) return;
	const floor = Math.round(state.position),
		newDirection = -state.direction;
	if ((floor == 0 && newDirection < 0) || (floor == 4 && newDirection > 0))
		return;
	state.direction = newDirection;
	addLog(`방향 ${newDirection > 0 ? "상승" : "하강"}으로 변경`);
}

// 정차 중 일어나는 하차·탑승 이벤트를 로그와 경주 결과에 반영한다
function onStopEvent(kind, floor, person) {
	if (kind == "drop") {
		addLog(`${floor + 1}층 하차${person.isUser ? " (사용자)" : ""}`);
		if (person.isUser && race && !race.elevatorDone) {
			race.elevatorDone = true;
			race.elevatorElapsed = state.time - race.startTime;
			showMeasureResult();
		}
	} else
		addLog(
			`${floor + 1}층 탑승${person.isUser ? " (사용자) → " + (person.dropFloor + 1) + "층" : " (가상 탑승자, 하차 안 함)"}`,
		);
}

// 엘리베이터와 계단이 둘 다 도착했으면 실측 결과를 보여 준다
function showMeasureResult() {
	const box = byId("measureResult");
	if (!box || !race) return;
	if (race.elevatorDone && race.stairDone)
		box.textContent =
			`실측: 엘리베이터 ${race.elevatorElapsed.toFixed(1)}초 / 계단 ${race.stairEstimate.toFixed(1)}초 → ` +
			(race.stairEstimate < race.elevatorElapsed
				? "계단 승"
				: race.elevatorElapsed < race.stairEstimate
					? "엘리베이터 승"
					: "무승부");
}

function initSimulation() {
	state = {
		position: 2, // 층 단위 위치(0~4, 소수 가능)
		direction: 0,
		stopLeft: 0, // 남은 정차 시간(초)
		calls: [],
		riders: [],
		time: 0, // 시뮬레이션 경과 시간(초)
		noDrop: true, // 가상 탑승자는 내리지 않는다
		virtualCount: 0, // 내리지 않는 가상 탑승자 수
	};
	random = makeRandom(Date.now() % 2147483647);
	race = null;
	nextCallTime = callGap();
	byId("log").innerHTML = "";
	byId("resultBox").className = "mut";
	byId("resultBox").textContent =
		"출발·도착 층을 고르고 실행하세요. 예상은 이후 새 호출이 없다고 가정한 값이에요.";
	lastGoFloor = -1;
	lastLedMask = -1;
	addLog("시작");
	newScenario();
}

// ---- 시리얼 ----
const sendLine = (text) => {
	if (serialWriter) serialWriter.write(text + "\n").catch(() => {});
};

// 호출 버튼 8개: [층, 방향]. LED 마스크의 비트 순서와 같다
const CALL_BUTTONS = [
	[0, 1],
	[1, 1],
	[1, -1],
	[2, 1],
	[2, -1],
	[3, 1],
	[3, -1],
	[4, -1],
];

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

// 시뮬레이션이 지금 상태에서 "이번에 실제로 멈출 층"(0~4). 없으면 null.
// 새 호출이 들어오면 값이 바뀔 수 있어서 syncModel()이 바뀔 때마다 다시 보낸다.
function nextStopFloor(state) {
	if (state.phase == "dec") return state.targetFloor;
	const nextFloor =
		state.direction > 0
			? Math.floor(state.position + 1e-9) + 1
			: Math.ceil(state.position - 1e-9) - 1;
	for (
		let floor = nextFloor;
		floor >= 0 && floor <= 4;
		floor += state.direction
	) {
		// 이미 통과하기로 판단한 다음 층(checkedFloor)은 건너뜀 (tick의 판단과 일치시키기)
		if (floor == nextFloor && state.checkedFloor === nextFloor) continue;
		if (
			shouldStop(state, floor, state.direction) ||
			!hasTargetAhead(state, floor, state.direction)
		)
			return floor;
	}
	return null;
}

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

const connectButtonLabel = byId("portConnector").textContent;

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
byId("portConnector").onclick = async () => {
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
};

byId("homeButton").onclick = () => {
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
};

// ---- 입력 ----
// containerId 안에 1~5층 버튼을 만들고, 누르면 onPick(층 번호 0~4)을 호출한다
function makeFloorButtons(containerId, onPick) {
	const container = byId(containerId);
	for (let index = 0; index < 5; index++) {
		const button = document.createElement("button");
		button.textContent = index + 1;
		button.onclick = () => {
			onPick(index);
			paintSelection();
		};
		container.appendChild(button);
	}
}

// 선택된 출발·도착 층 버튼을 강조한다
function paintSelection() {
	[...byId("fromButtons").children].forEach((button, index) =>
		button.classList.toggle("on", index == fromFloor),
	);
	[...byId("toButtons").children].forEach((button, index) =>
		button.classList.toggle("on", index == toFloor),
	);
}

makeFloorButtons("fromButtons", (index) => (fromFloor = index));
makeFloorButtons("toButtons", (index) => (toFloor = index));
paintSelection();
byId("startButton").onclick = () => {
	readParams();
	// 모형이 아직 준비 중이거나 시작 층으로 이동 중이면 시작하지 않는다
	if (serialWriter && (!modelReady || waitingFloor)) {
		byId("resultBox").className = "mut";
		byId("resultBox").textContent =
			"모형이 준비·이동 중이에요. 도착하면 다시 눌러 주세요.";
		return;
	}
	const from = fromFloor,
		to = toFloor;
	if (from == to) {
		byId("resultBox").className = "mut";
		byId("resultBox").textContent = "출발 층과 도착 층이 같아요.";
		return;
	}
	const elevatorEstimate = estimateElevatorTime(from, to),
		stairEstimate = calcStairTime(from, to);
	if (elevatorEstimate === null) {
		byId("resultBox").textContent = "예상 계산에 실패했어요.";
		return;
	}
	const winnerText =
		stairEstimate < elevatorEstimate
			? "계단이 더 빠릅니다"
			: elevatorEstimate < stairEstimate
				? "엘리베이터가 더 빠릅니다"
				: "같은 시간";
	byId("resultBox").className = "";
	byId("resultBox").innerHTML =
		`<div class="tiles"><div class="tile ${elevatorEstimate < stairEstimate ? "win" : ""}"><span>엘리베이터 예상</span><b>${elevatorEstimate.toFixed(1)}</b>초</div><div class="tile ${stairEstimate < elevatorEstimate ? "win" : ""}"><span>계단 예상</span><b>${stairEstimate.toFixed(1)}</b>초</div></div><div class="verdict">${winnerText} (${Math.abs(elevatorEstimate - stairEstimate).toFixed(1)}초 차이)</div><div class="mut" style="text-align:center">가상 탑승자는 하차하지 않는다고 가정한 값이에요</div><div class="bar"><span>엘리베이터</span><div><i id="elevatorBar"></i></div><em id="elevatorTimeText">0.0초</em></div><div class="bar"><span>계단</span><div><i id="stairBar"></i></div><em id="stairTimeText">0.0초</em></div><div id="measureResult" class="mut" style="text-align:center;margin-top:6px"></div>`;
	addCall(state, from, to > from ? 1 : -1, to, true);
	running = true;
	race = {
		from,
		to,
		stairElapsed: 0, // 계단 쪽 경과 시간(초)
		startTime: state.time, // 경주를 시작한 시뮬레이션 시각
		stairDuration: stairEstimate,
		elevatorEstimate,
		stairDone: false,
		elevatorDone: false,
		stairEstimate,
		// elevatorElapsed: 엘리베이터 실측 시간 (도착하면 채워짐)
	};
	// 계단은 모형이 없으므로 아두이노에는 아무것도 보내지 않는다.
	// 정차 층은 syncModel()이 이동이 시작되는 프레임에 알아서 보낸다.
	lastGoFloor = -1;
	addLog(`경주 시작 ${from + 1}층→${to + 1}층`);
};

byId("autoCall").onchange = () => {
	autoCallEnabled = byId("autoCall").checked;
	if (autoCallEnabled) nextCallTime = state.time + callGap();
};

byId("newScenarioButton").onclick = newScenario;

// 모형 연결 중에는 배속 상한을 넘기지 못하게 한다
byId("speedMult").addEventListener("change", () => {
	if (serialWriter) limitSpeedMultForModel();
});

// ---- 화면 ----
const floorStrip = byId("floorStrip"),
	cells = [];

const shaft = document.createElement("div");
shaft.className = "shaft";

floorStrip.appendChild(shaft);

for (let floor = 4; floor >= 0; floor--) {
	const row = document.createElement("div");
	row.className = "cell";
	row.innerHTML = `<b style="width:30px">${floor + 1}F</b><span class="ar u">${floor < 4 ? "▲" : ""}</span><span class="ar d">${floor > 0 ? "▼" : ""}</span><i class="x"></i>`;
	floorStrip.appendChild(row);
	cells[floor] = {
		row,
		upArrow: row.querySelector(".u"),
		downArrow: row.querySelector(".d"),
		destDot: row.querySelector(".x"),
	};
	if (floor < 4) cells[floor].upArrow.onclick = () => toggleCall(floor, 1);
	if (floor > 0) cells[floor].downArrow.onclick = () => toggleCall(floor, -1);
	row.querySelector("b").onclick = () => moveCarTo(floor);
}

const car = document.createElement("div");

car.className = "car";
car.onclick = flipDirection;
floorStrip.appendChild(car);

function render() {
	const stripHeight = floorStrip.clientHeight,
		cellHeight = (stripHeight - 24) / 5;
	car.style.height = cellHeight - 12 + "px";
	car.style.bottom = state.position * (cellHeight + 6) + 6 + "px";
	car.textContent = state.direction > 0 ? "▲" : state.direction < 0 ? "▼" : "–";
	const litCalls = new Set(
			state.calls.map((call) => call.floor + "_" + call.direction),
		),
		destFloors = new Set(state.riders.map((rider) => rider.destFloor));
	cells.forEach((cell, floor) => {
		cell.upArrow.classList.toggle("on", litCalls.has(floor + "_1"));
		cell.downArrow.classList.toggle("on", litCalls.has(floor + "_-1"));
		cell.destDot.style.opacity = destFloors.has(floor) ? 1 : 0;
		cell.row.classList.toggle("here", Math.round(state.position) == floor);
	});
	const carFloor = Math.round(state.position) + 1,
		statusText = !running
			? "시간 정지"
			: state.stopLeft > 0
				? "정차 중"
				: state.direction > 0
					? "상승 중"
					: state.direction < 0
						? "하강 중"
						: "대기";
	byId("statusBox").innerHTML =
		`<b>${carFloor}층 ${state.direction > 0 ? "▲" : state.direction < 0 ? "▼" : ""}</b> · ${statusText} · ${state.time.toFixed(0)}초${running ? "" : '<div class="mut">시간이 멈춘 상태예요. 비교 + 출발을 누르면 시작해요.</div>'}<div class="mut">호출 대기 ${state.calls.map((call) => call.floor + 1 + (call.direction > 0 ? "▲" : "▼")).join(" ") || "없음"} · 내 목적 층 ${state.riders.map((rider) => rider.destFloor + 1).join(" ") || "-"}</div>`;
	if (race && byId("elevatorBar")) {
		const elapsed = race.elevatorDone
			? race.elevatorElapsed
			: state.time - race.startTime;
		byId("elevatorBar").style.width =
			(race.elevatorDone
				? 100
				: Math.min(95, (elapsed / race.elevatorEstimate) * 100)) + "%";
		byId("elevatorTimeText").textContent = elapsed.toFixed(1) + "초";
		byId("stairBar").style.width =
			(race.stairElapsed / race.stairDuration) * 100 + "%";
		byId("stairTimeText").textContent = race.stairElapsed.toFixed(1) + "초";
	}
}

initSimulation();
(function frame(now) {
	const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
	lastFrameTime = now;
	readParams();
	if (running) accumulatedTime += dt * params.speedMult;
	while (accumulatedTime >= 0.05) {
		accumulatedTime -= 0.05;
		if (autoCallEnabled && state.time >= nextCallTime) {
			addRandomCall();
			nextCallTime = state.time + callGap();
		}
		tick(state, 0.05, onStopEvent);
		if (race && !race.stairDone) {
			race.stairElapsed += 0.05;
			if (race.stairElapsed >= race.stairDuration) {
				race.stairElapsed = race.stairDuration;
				race.stairDone = true;
				showMeasureResult();
			}
		}
	}
	render();
	syncModel();
	requestAnimationFrame(frame);
})(performance.now());
