const $ = (id) => document.getElementById(id);
const P = { fT: 6.5, sT: 5, stU: 10, stD: 6, aT: 2, mult: 4 };
const stairT = (a, b) => Math.abs(b - a) * (b > a ? P.stU : P.stD);

function rng(a) {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

let S,
	rand,
	nextCall,
	autoOn = false,
	running = false,
	race = null,
	serial = null,
	acc = 0,
	last = performance.now(),
	lastGo = -1,
	lastMask = -1,
	selF = 1,
	selT = 4;

const gap = () => {
	const a = +$("gmin").value || 5,
		b = Math.max(a, +$("gmax").value || 15);
	return a + rand() * (b - a);
};

const readP = () => {
	P.fT = +$("fT").value || 6.5;
	P.sT = +$("sT").value || 5;
	P.stU = +$("stU").value || 10;
	P.stD = +$("stD").value || 6;
	P.aT = +$("aT").value || 2;
	P.mult = +$("mult").value || 4;
};

function lg(m) {
	const d = document.createElement("div");
	d.textContent = (S ? S.t.toFixed(0).padStart(3, " ") + "s " : "") + m;
	$("log").prepend(d);
	while ($("log").children.length > 80) $("log").lastChild.remove();
}

$("resetLog").onclick = () => {
	$("log").innerHTML = "";
};

// ---- 운행 엔진 (층 0~4) ----
const tg = (s) => [...s.calls.map((c) => c.f), ...s.riders.map((r) => r.dest)];

const ahead = (s, f, d) => tg(s).some((t) => (t - f) * d > 0),
	behind = (s, f, d) => tg(s).some((t) => (t - f) * d < 0);

const shouldStop = (s, f, d) =>
	s.riders.some((r) => r.dest == f) ||
	s.calls.some((c) => c.f == f && (c.d == d || !ahead(s, f, d)));

function fixDir(s) {
	const f = Math.round(s.pos);
	if (s.dir && !ahead(s, f, s.dir)) s.dir = behind(s, f, s.dir) ? -s.dir : 0;
}

function doStop(s, ev) {
	const f = Math.round(s.pos);
	let d = s.dir,
		acted = false;
	s.riders = s.riders.filter((r) => {
		if (r.dest == f) {
			acted = true;
			ev && ev("drop", f, r);
			return false;
		}
		return true;
	});
	if (!ahead(s, f, d)) {
		const w = s.calls.find((c) => c.f == f);
		if (w) d = w.d;
		else if (behind(s, f, d)) d = -d;
		else d = 0;
	}
	s.calls = s.calls.filter((c) => {
		if (c.f == f && c.d == d) {
			acted = true;
			c.pax.forEach((p) => {
				ev && ev("board", f, p);
				if (!(s.noDrop && !p.user))
					s.riders.push({ dest: p.drop, user: p.user });
				else s.occ++;
			});
			return false;
		}
		return true;
	});
	if (d != 0 && !ahead(s, f, d) && !behind(s, f, d)) d = 0;
	s.dir = d;
	s.stop = acted ? P.sT : 0;
	s.ph = "rest";
}

// 속도 모델: 정지 -> 가속(aT초, 선형) -> 순항(층당 fT초) -> 감속(aT초, 선형) -> 정차(sT초)
function tick(s, dt, ev) {
	s.t += dt;
	if (s.stop > 0) {
		s.stop -= dt;
		if (s.stop <= 0) {
			s.stop = 0;
			fixDir(s);
		}
		return;
	}
	const f = Math.round(s.pos),
		v0 = 1 / P.fT,
		T = Math.max(0.1, P.aT);
	if (s.dir == 0) {
		s.ph = "rest";
		const Tg = tg(s);
		if (!Tg.length) return;
		if (s.calls.some((c) => c.f == f) || s.riders.some((r) => r.dest == f)) {
			doStop(s, ev);
			return;
		}
		s.dir = Math.sign(
			Tg.reduce((a, b) => (Math.abs(b - s.pos) < Math.abs(a - s.pos) ? b : a)) -
				s.pos,
		);
		return;
	}
	if (!s.ph || s.ph == "rest") {
		s.ph = "acc";
		s.pt = 0;
		s.chk = null;
	}
	const nx =
		s.dir > 0 ? Math.floor(s.pos + 1e-9) + 1 : Math.ceil(s.pos - 1e-9) - 1;
	s.pt += dt;
	let sp;
	if (s.ph == "dec") {
		if (s.pt >= T) {
			s.pos = s.tgt;
			doStop(s, ev);
			return;
		}
		sp = v0 * (1 - s.pt / T);
	} else {
		if (s.ph == "acc" && s.pt >= T) s.ph = "cruise";
		sp = s.ph == "acc" ? (v0 * s.pt) / T : v0;
		if (s.chk !== nx && Math.abs(nx - s.pos) <= (v0 * T) / 2 + 1e-9) {
			s.chk = nx;
			if (shouldStop(s, nx, s.dir) || !ahead(s, nx, s.dir)) {
				s.ph = "dec";
				s.pt = 0;
				s.tgt = nx;
				sp = v0;
			}
		}
	}
	let np = s.pos + s.dir * sp * dt;
	if (s.ph == "dec") {
		if ((np - s.tgt) * s.dir > 0) np = s.tgt;
		s.pos = np;
	} else if ((np - nx) * s.dir >= -1e-9) {
		s.pos = nx;
		s.chk = null;
	} else s.pos = np;
}

function addCall(s, f, d, drop, user) {
	let c = s.calls.find((c) => c.f == f && c.d == d);
	if (!c) {
		c = { f, d, pax: [] };
		s.calls.push(c);
	}
	c.pax.push({ drop, user });
}

function estimate(from, to) {
	const s = JSON.parse(JSON.stringify(S));
	addCall(s, from, to > from ? 1 : -1, to, true);
	let done = null;
	const t0 = s.t;
	const ev = (k, f, x) => {
		if (k == "drop" && x.user) done = s.t - t0;
	};
	for (let i = 0; i < 40000 && done === null; i++) tick(s, 0.05, ev);
	return done;
}

function randCall() {
	const o = [];
	for (let f = 0; f < 5; f++) {
		if (f < 4) o.push([f, 1]);
		if (f > 0) o.push([f, -1]);
	}
	const [f, d] = o[Math.floor(rand() * o.length)],
		m = $("dmode").value;
	let drop;
	if (m == "rule") drop = d > 0 ? Math.min(f + 2, 4) : Math.max(f - 2, 0);
	else if (m == "end") drop = d > 0 ? 4 : 0;
	else {
		const c = [];
		for (let k = 0; k < 5; k++) if ((k - f) * d > 0) c.push(k);
		drop = c[Math.floor(rand() * c.length)];
	}
	addCall(S, f, d, drop, false);
	lg(`호출 ${f + 1}층${d > 0 ? "▲" : "▼"}`);
}

function dropFor(f, d) {
	const m = $("dmode").value;
	if (m == "rule") return d > 0 ? Math.min(f + 2, 4) : Math.max(f - 2, 0);
	if (m == "end") return d > 0 ? 4 : 0;
	const c = [];
	for (let k = 0; k < 5; k++) if ((k - f) * d > 0) c.push(k);
	return c[Math.floor(rand() * c.length)];
}

function scenario() {
	running = false;
	S.calls = [];
	S.riders = [];
	S.stop = 0;
	S.t = 0;
	race = null;
	nextCall = gap();
	lastGo = -1;
	lastMask = -1;
	$("res").className = "mut";
	$("res").textContent =
		"출발·도착 층을 고르고 실행하세요. 예상은 이후 새 호출이 없다고 가정한 값이에요.";
	const f = Math.floor(rand() * 5);
	let d = rand() < 0.5 ? 1 : -1;
	if (f == 0) d = 1;
	if (f == 4) d = -1;
	S.pos = f;
	S.dir = d;
	S.ph = "cruise";
	S.pt = 0;
	S.chk = null;
	KEYS.forEach(([cf, cd]) => {
		if (!(cf == f && cd == d) && rand() < 0.4)
			addCall(S, cf, cd, dropFor(cf, cd), false);
	});
	if (!ahead(S, f, d)) {
		const c = [];
		for (let k = 0; k < 5; k++) if ((k - f) * d > 0) c.push(k);
		const k = c[Math.floor(rand() * c.length)],
			kd = k == 4 ? -1 : k == 0 ? 1 : rand() < 0.5 ? 1 : -1;
		addCall(S, k, kd, 0, false);
	}
	S.occ = Math.floor(rand() * 4);
	tx("GO " + (f + 1));
	lg(
		`새 상황: 엘리베이터 ${f + 1}층 ${d > 0 ? "상승" : "하강"} 중 · 호출 ${S.calls.map((c) => c.f + 1 + (c.d > 0 ? "▲" : "▼")).join(" ") || "없음"}`,
	);
}

function toggleCall(f, d) {
	const i = S.calls.findIndex((c) => c.f == f && c.d == d);
	if (i >= 0) {
		if (S.calls[i].pax.some((p) => p.user)) return;
		S.calls.splice(i, 1);
		lg(`호출 취소 ${f + 1}층${d > 0 ? "▲" : "▼"}`);
	} else {
		addCall(S, f, d, 0, false);
		lg(`호출 ${f + 1}층${d > 0 ? "▲" : "▼"}`);
	}
}

function moveCar(f) {
	if (running) return;
	S.pos = f;
	S.stop = 0;
	S.ph = "cruise";
	S.chk = null;
	S.dir = f == 0 ? 1 : f == 4 ? -1 : S.dir || 1;
	lastGo = -1;
	tx("GO " + (f + 1));
	lg(`엘리베이터 ${f + 1}층으로 이동`);
}

function flipDir() {
	if (running) return;
	const f = Math.round(S.pos),
		nd = -S.dir;
	if ((f == 0 && nd < 0) || (f == 4 && nd > 0)) return;
	S.dir = nd;
	lg(`방향 ${nd > 0 ? "상승" : "하강"}으로 변경`);
}

function evLive(k, f, x) {
	if (k == "drop") {
		lg(`${f + 1}층 하차${x.user ? " (사용자)" : ""}`);
		if (x.user && race && !race.ed) {
			race.ed = true;
			race.tE = S.t - race.t0;
			fin();
		}
	} else
		lg(
			`${f + 1}층 탑승${x.user ? " (사용자) → " + (x.drop + 1) + "층" : " (가상 탑승자, 하차 안 함)"}`,
		);
}

function fin() {
	const m = $("meas");
	if (!m || !race) return;
	if (race.ed && race.sd)
		m.textContent =
			`실측: 엘리베이터 ${race.tE.toFixed(1)}초 / 계단 ${race.St.toFixed(1)}초 → ` +
			(race.St < race.tE
				? "계단 승"
				: race.tE < race.St
					? "엘리베이터 승"
					: "무승부");
}

function init() {
	S = {
		pos: 2,
		dir: 0,
		stop: 0,
		calls: [],
		riders: [],
		t: 0,
		noDrop: true,
		occ: 0,
	};
	rand = rng(Date.now() % 2147483647);
	race = null;
	nextCall = gap();
	$("log").innerHTML = "";
	$("res").className = "mut";
	$("res").textContent =
		"출발·도착 층을 고르고 실행하세요. 예상은 이후 새 호출이 없다고 가정한 값이에요.";
	lastGo = -1;
	lastMask = -1;
	lg("시작");
	scenario();
}

// ---- 시리얼 ----
const tx = (s) => {
	if (serial) serial.write(s + "\n").catch(() => {});
};

const KEYS = [
	[0, 1],
	[1, 1],
	[1, -1],
	[2, 1],
	[2, -1],
	[3, 1],
	[3, -1],
	[4, -1],
];

const mask = () =>
	KEYS.reduce(
		(m, [f, d], i) =>
			m | (S.calls.some((c) => c.f == f && c.d == d) ? 1 << i : 0),
		0,
	);
function sync() {
	if (!serial) return;
	const m = mask();
	if (m !== lastMask) {
		tx("LED " + m);
		lastMask = m;
	}
	if (running && S.dir && !S.stop) {
		const nx =
			S.dir > 0 ? Math.floor(S.pos + 1e-9) + 1 : Math.ceil(S.pos - 1e-9) - 1;
		if (nx !== lastGo) {
			tx("GO " + (nx + 1));
			lastGo = nx;
		}
	}
}

$("con").onclick = async () => {
	if (!("serial" in navigator)) {
		$("cst").textContent = "이 브라우저는 Web Serial 미지원 (Chrome/Edge 필요)";
		return;
	}
	try {
		const p = await navigator.serial.requestPort();
		await p.open({ baudRate: 115200 });
		const enc = new TextEncoderStream();
		enc.readable.pipeTo(p.writable);
		serial = enc.writable.getWriter();
		$("con").textContent = "모형 연결됨";
		$("con").classList.add("ok");
		$("cst").textContent = "연결됨 · 명령 전송 중";
		lg("시리얼 연결");
		const rd = p.readable.pipeThrough(new TextDecoderStream()).getReader();
		let buf = "";
		(async () => {
			for (;;) {
				const { value, done } = await rd.read();
				if (done) break;
				buf += value;
				let i;
				while ((i = buf.indexOf("\n")) >= 0) {
					lg("← " + buf.slice(0, i).trim());
					buf = buf.slice(i + 1);
				}
			}
		})();
	} catch (e) {
		$("cst").textContent =
			"연결 실패: " + (e.message || e) + " (미리보기 안에서는 막힐 수 있어요)";
	}
};

$("home").onclick = () => {
	tx("HOME");
	lg("→ HOME");
};

// ---- 입력 ----
function seg(id, get, set) {
	const b = $(id);
	for (let i = 0; i < 5; i++) {
		const x = document.createElement("button");
		x.textContent = i + 1;
		x.onclick = () => {
			set(i);
			paint();
		};
		b.appendChild(x);
	}
}

function paint() {
	[...$("sf").children].forEach((b, i) => b.classList.toggle("on", i == selF));
	[...$("sd").children].forEach((b, i) => b.classList.toggle("on", i == selT));
}

seg("sf", 0, (i) => (selF = i));
seg("sd", 0, (i) => (selT = i));
paint();
$("go").onclick = () => {
	readP();
	const from = selF,
		to = selT;
	if (from == to) {
		$("res").className = "mut";
		$("res").textContent = "출발 층과 도착 층이 같아요.";
		return;
	}
	const E = estimate(from, to),
		St = stairT(from, to);
	if (E === null) {
		$("res").textContent = "예상 계산에 실패했어요.";
		return;
	}
	const w =
		St < E
			? "계단이 더 빠릅니다"
			: E < St
				? "엘리베이터가 더 빠릅니다"
				: "같은 시간";
	$("res").className = "";
	$("res").innerHTML =
		`<div class="tiles"><div class="tile ${E < St ? "win" : ""}"><span>엘리베이터 예상</span><b>${E.toFixed(1)}</b>초</div><div class="tile ${St < E ? "win" : ""}"><span>계단 예상</span><b>${St.toFixed(1)}</b>초</div></div><div class="verdict">${w} (${Math.abs(E - St).toFixed(1)}초 차이)</div><div class="mut" style="text-align:center">가상 탑승자는 하차하지 않는다고 가정한 값이에요</div><div class="bar"><span>엘리베이터</span><div><i id="be"></i></div><em id="te">0.0초</em></div><div class="bar"><span>계단</span><div><i id="bs"></i></div><em id="ts">0.0초</em></div><div id="meas" class="mut" style="text-align:center;margin-top:6px"></div>`;
	addCall(S, from, to > from ? 1 : -1, to, true);
	running = true;
	race = {
		from,
		to,
		t: 0,
		t0: S.t,
		dur: St,
		E,
		sd: false,
		ed: false,
		St,
	};
	tx(`STAIR ${from + 1} ${to + 1} ${Math.round((St * 1000) / P.mult)}`);
	lg(`경주 시작 ${from + 1}층→${to + 1}층`);
};

$("auto").onchange = () => {
	autoOn = $("auto").checked;
	if (autoOn) nextCall = S.t + gap();
};

$("scn").onclick = scenario;

// ---- 화면 ----
const strip = $("strip"),
	cells = [];

const sh = document.createElement("div");
sh.className = "shaft";

strip.appendChild(sh);

for (let f = 4; f >= 0; f--) {
	const e = document.createElement("div");
	e.className = "cell";
	e.innerHTML = `<b style="width:30px">${f + 1}F</b><span class="ar u">${f < 4 ? "▲" : ""}</span><span class="ar d">${f > 0 ? "▼" : ""}</span><i class="x"></i>`;
	strip.appendChild(e);
	cells[f] = {
		e,
		u: e.querySelector(".u"),
		d: e.querySelector(".d"),
		x: e.querySelector(".x"),
	};
	if (f < 4) cells[f].u.onclick = () => toggleCall(f, 1);
	if (f > 0) cells[f].d.onclick = () => toggleCall(f, -1);
	e.querySelector("b").onclick = () => moveCar(f);
}

const mk = document.createElement("div");

mk.className = "car";
mk.onclick = flipDir;
strip.appendChild(mk);

function render() {
	const H = strip.clientHeight,
		h = (H - 24) / 5;
	mk.style.height = h - 12 + "px";
	mk.style.bottom = S.pos * (h + 6) + 6 + "px";
	mk.textContent = S.dir > 0 ? "▲" : S.dir < 0 ? "▼" : "–";
	const lit = new Set(S.calls.map((c) => c.f + "_" + c.d)),
		dests = new Set(S.riders.map((r) => r.dest));
	cells.forEach((c, f) => {
		c.u.classList.toggle("on", lit.has(f + "_1"));
		c.d.classList.toggle("on", lit.has(f + "_-1"));
		c.x.style.opacity = dests.has(f) ? 1 : 0;
		c.e.classList.toggle("here", Math.round(S.pos) == f);
	});
	const f = Math.round(S.pos) + 1,
		st = !running
			? "시간 정지"
			: S.stop > 0
				? "정차 중"
				: S.dir > 0
					? "상승 중"
					: S.dir < 0
						? "하강 중"
						: "대기";
	$("stat").innerHTML =
		`<b>${f}층 ${S.dir > 0 ? "▲" : S.dir < 0 ? "▼" : ""}</b> · ${st} · ${S.t.toFixed(0)}초${running ? "" : '<div class="mut">시간이 멈춘 상태예요. 비교 + 출발을 누르면 시작해요.</div>'}<div class="mut">호출 대기 ${S.calls.map((c) => c.f + 1 + (c.d > 0 ? "▲" : "▼")).join(" ") || "없음"} · 내 목적 층 ${S.riders.map((r) => r.dest + 1).join(" ") || "-"}</div>`;
	if (race && $("be")) {
		const e = race.ed ? race.tE : S.t - race.t0;
		$("be").style.width =
			(race.ed ? 100 : Math.min(95, (e / race.E) * 100)) + "%";
		$("te").textContent = e.toFixed(1) + "초";
		$("bs").style.width = (race.t / race.dur) * 100 + "%";
		$("ts").textContent = race.t.toFixed(1) + "초";
	}
}

init();
(function frame(now) {
	const dt = Math.min(0.1, (now - last) / 1000);
	last = now;
	readP();
	if (running) acc += dt * P.mult;
	while (acc >= 0.05) {
		acc -= 0.05;
		if (autoOn && S.t >= nextCall) {
			randCall();
			nextCall = S.t + gap();
		}
		tick(S, 0.05, evLive);
		if (race && !race.sd) {
			race.t += 0.05;
			if (race.t >= race.dur) {
				race.t = race.dur;
				race.sd = true;
				fin();
			}
		}
	}
	render();
	sync();
	requestAnimationFrame(frame);
})(performance.now());
