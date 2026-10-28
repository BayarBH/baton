// Baton sidebar (Zoom App). Receives status + nudges over SSE; actions: next step, adopted/ignored per nudge.
const token = document.querySelector('meta[name="baton-token"]').content;
const $ = (id) => document.getElementById(id);

const TEXT = {
  ja: { brand: 'Shikiri（仕切り）', start: 'ファシリテーション開始', next: '次のステップへ', step: (i, n) => `ステップ ${i}/${n}`, waiting: '会議データの受信を待っています…', noToken: 'Zoom 会議のサイドバーから開いてください。', ended: '会議は終了しました。', lost: '再接続中…', adopted: '採用', ignored: '無視' },
  zh: { brand: 'Baton', start: '开始引导', next: '下一步', step: (i, n) => `步骤 ${i}/${n}`, waiting: '正在等待会议数据…', noToken: '请在 Zoom 会议侧边栏中打开。', ended: '会议已结束。', lost: '正在重新连接…', adopted: '采纳', ignored: '忽略' },
  en: { brand: 'Baton', start: 'Start facilitating', next: 'Next step', step: (i, n) => `Step ${i} of ${n}`, waiting: 'Waiting for meeting data…', noToken: 'Open Baton from the Zoom meeting sidebar.', ended: 'The meeting has ended.', lost: 'Reconnecting…', adopted: 'Acted on', ignored: 'Ignore' },
};
const guess = navigator.language.startsWith('ja') ? 'ja' : navigator.language.startsWith('en') ? 'en' : 'zh'; // default: Chinese

let status; // latest SessionStatus
let receivedAt = 0; // performance.now() when it arrived
let inZoom = false;
const items = new Map(); // nudge id -> <li>

const t = () => TEXT[status?.locale ?? guess];
const mmss = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

function render() {
  const T = t();
  document.documentElement.lang = status?.locale ?? guess;
  $('brand').textContent = T.brand;
  $('start').textContent = T.start;
  $('next').textContent = T.next;
  $('start').hidden = !inZoom || (status && !status.ended);
  const step = status?.step;
  $('step').hidden = !step;
  if (step) {
    $('step-index').textContent = T.step(step.index + 1, step.count);
    $('step-name').textContent = step.name;
    $('step-goal').textContent = step.goal;
    $('step-script').textContent = step.script ?? '';
  }
  for (const li of items.values()) labelVerdicts(li);
  $('notice').textContent = !token ? T.noToken : status?.ended ? T.ended : !status ? T.waiting : '';
  tick();
}

function tick() {
  const step = status?.step;
  if (!step) return;
  const now = status.ended ? status.elapsedMs : status.elapsedMs + (performance.now() - receivedAt);
  const left = step.startedAtMs + step.timeboxMs - now;
  $('clock').textContent = left >= 0 ? mmss(left + 999) : `+${mmss(-left)}`;
  $('clock').classList.toggle('over', left < 0);
}

function addNudge(n) {
  if (items.has(n.id)) return; // the server replays history on reconnect
  const li = document.createElement('li');
  li.className = `p${n.priority}`;
  const time = document.createElement('time');
  time.textContent = mmss(n.atMs);
  const actions = document.createElement('div');
  actions.className = 'verdict';
  for (const verdict of ['adopted', 'ignored']) {
    const b = document.createElement('button');
    b.dataset.verdict = verdict;
    b.addEventListener('click', () => sendFeedback(n.id, verdict));
    actions.append(b);
  }
  li.append(time, n.message, actions);
  items.set(n.id, li);
  labelVerdicts(li);
  $('nudges').prepend(li);
}

function labelVerdicts(li) {
  for (const b of li.querySelectorAll('.verdict button')) b.textContent = t()[b.dataset.verdict];
}

/** Shared across the meeting's sidebars: the latest verdict is highlighted, and can be changed. */
function showFeedback(nudgeId, verdict) {
  for (const b of items.get(nudgeId)?.querySelectorAll('.verdict button') ?? []) b.classList.toggle('chosen', b.dataset.verdict === verdict);
}

/** The token dies with a server restart: reload to get a fresh one from the home URL. */
const reloadSoon = () => setTimeout(() => location.reload(), 5000);

async function sendFeedback(nudgeId, verdict) {
  showFeedback(nudgeId, verdict);
  const res = await fetch(`/feedback?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nudgeId, verdict }) });
  if (res.status === 401) reloadSoon();
}

$('next').addEventListener('click', async () => {
  $('next').disabled = true;
  try {
    const res = await fetch(`/next?token=${encodeURIComponent(token)}`, { method: 'POST' });
    if (res.status === 401) reloadSoon();
    if (res.status === 409 && (await res.json()).error === 'not_controllable') $('next').hidden = true; // replay demo
  } finally {
    setTimeout(() => ($('next').disabled = false), 1000);
  }
});

$('start').addEventListener('click', async () => {
  try {
    await window.zoomSdk.startRTMS();
  } catch (err) {
    console.error('startRTMS failed', err);
  }
});

if (token) {
  const es = new EventSource(`/events?token=${encodeURIComponent(token)}`);
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'status') {
      status = msg.status;
      receivedAt = performance.now() - (msg.ageMs ?? 0);
      render();
    } else if (msg.type === 'nudge') addNudge(msg.nudge);
    else if (msg.type === 'feedback') showFeedback(msg.nudgeId, msg.verdict);
  };
  es.onerror = () => {
    if (!status?.ended) $('notice').textContent = t().lost;
    if (es.readyState === EventSource.CLOSED) reloadSoon(); // e.g. 401 after a server restart: the browser won't retry
  };
  es.onopen = () => render();
}

if (window.zoomSdk) {
  try {
    await window.zoomSdk.config({ version: '0.16.31', capabilities: ['getRunningContext', 'startRTMS', 'onRTMSStatusChange'] });
    inZoom = (await window.zoomSdk.getRunningContext()).context === 'inMeeting';
  } catch (err) {
    console.warn('Zoom Apps SDK unavailable', err);
  }
}
render();
setInterval(tick, 1000);
