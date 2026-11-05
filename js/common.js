// common.js — 모든 파일이 함께 쓰는 값: 설정(params), 시뮬레이션 상태와 공유 전역 변수, 입력 읽기, 로그.
// 가장 먼저 로드한다. (일반 <script>끼리는 최상위 const/let을 서로 공유한다)

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

const connectButtonLabel = byId("portConnector").textContent;

// ---- 화면 ----
const floorStrip = byId("floorStrip"),
	cells = [];

const car = document.createElement("div");
