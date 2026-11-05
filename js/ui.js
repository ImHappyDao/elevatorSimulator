// ui.js — 시나리오·호출 조작, 입력 버튼, 화면 그리기.
// 최상단에서 바로 실행되는 코드는 없다. 함수 선언만 두고, 연결·실행은 main.js에서 한다.

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

function startRace() {
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
}

function onAutoCallChange() {
	autoCallEnabled = byId("autoCall").checked;
	if (autoCallEnabled) nextCallTime = state.time + callGap();
}

// 승강로, 층별 칸, 카를 만들어 화면 영역(floorStrip)에 붙인다
function buildFloorStrip() {
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

	car.className = "car";
	car.onclick = flipDirection;
	floorStrip.appendChild(car);
}

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
