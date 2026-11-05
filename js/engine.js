// engine.js — 엘리베이터 운행 계산. 화면·통신과 무관하다.
// common.js의 params(설정)와 state(상태)를 사용한다.

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
