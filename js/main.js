// main.js — 모든 선언이 로드된 뒤 한 번 실행되는 연결과 시작. 반드시 마지막에 로드한다.

byId("portConnector").onclick = connectSerial;
byId("homeButton").onclick = requestHome;

makeFloorButtons("fromButtons", (index) => (fromFloor = index));
makeFloorButtons("toButtons", (index) => (toFloor = index));
paintSelection();
byId("startButton").onclick = startRace;

byId("autoCall").onchange = onAutoCallChange;

byId("newScenarioButton").onclick = newScenario;

byId("speedMult").addEventListener("change", onSpeedMultChange);

buildFloorStrip();

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
