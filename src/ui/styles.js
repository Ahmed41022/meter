/** Component styles. Kept as a string so the build stays a single file with
 *  no CSS pipeline — the app ships as one HTML document. */
export const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=DM+Mono:wght@300;400;500&display=swap');

.mtr {
  --paper:#F1F3EF; --card:#FFFFFF; --raise:#F7F9F5;
  --ink:#101613; --ink-2:#3C4742; --muted:#75827B; --line:#E2E7E0; --line-2:#EDF0EA;
  --jade:#0F7B5A; --jade-hi:#12946B; --jade-soft:#DCEFE5;
  --flag:#C2493C; --flag-soft:#FBEAE7;
  --amber:#A8762A; --amber-soft:#F4EBD8; --amber-line:#E3D3B0;
  --sans:'Archivo',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'DM Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;
  --shadow:0 1px 2px rgba(16,22,19,.05), 0 10px 30px rgba(16,22,19,.06);
  background:var(--paper); color:var(--ink); font-family:var(--sans);
  min-height:100vh; padding:26px 16px 96px; font-size:15px;
  -webkit-font-smoothing:antialiased;
}
.mtr *{box-sizing:border-box;}
.mtr :focus-visible{outline:2px solid var(--jade); outline-offset:2px;}
.wrap{max-width:660px;margin:0 auto;}
.eyebrow{font-weight:600;text-transform:uppercase;letter-spacing:.1em;
  font-size:10.5px;color:var(--muted);}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums;}

.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:26px;}
.mark{font-weight:700;letter-spacing:-.02em;font-size:19px;color:var(--ink);}
.linkbtn{background:none;border:0;color:var(--muted);font-family:inherit;font-weight:600;
  font-size:13px;cursor:pointer;padding:7px 4px;border-radius:6px;}
.linkbtn:hover{color:var(--jade);}

/* meter face */
.face{background:var(--card);border:1px solid var(--line);border-radius:16px;
  padding:26px 24px 22px;box-shadow:var(--shadow);}
.face-top{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:22px;}
.plate-name{font-weight:700;font-size:20px;letter-spacing:-.02em;line-height:1.15;}
.plate-rate{margin-top:5px;font-size:12.5px;color:var(--muted);font-family:var(--mono);}
.state{font-weight:600;text-transform:uppercase;letter-spacing:.09em;font-size:10px;
  padding:6px 11px;border-radius:999px;background:var(--line-2);color:var(--muted);white-space:nowrap;}
.state.on{background:var(--jade-soft);color:var(--jade);}
.state.idling{background:var(--amber-soft);color:var(--amber);}

/* Idle mode repaints the whole face. The money figure sits in the same slot
   but means the opposite thing, so it must never look the same. */
.face.idle{background:#FCFAF5;border-color:var(--amber-line);}
.face.idle .money-head{color:var(--amber);}
.face.idle .money-tail{color:var(--amber);opacity:.55;}
.face.idle .tick.filled{background:#EBDCBE;}
.face.idle .tick.head{background:var(--amber);}
.face.idle .btn.primary{background:var(--amber);border-color:var(--amber);}
.face.idle .btn.primary:hover{background:#BE8930;border-color:#BE8930;}
.money-label{margin-top:9px;font-size:12px;color:var(--amber);font-weight:600;}

/* utilisation */
.util{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px;}
.util-pct{font-family:var(--mono);font-size:20px;font-variant-numeric:tabular-nums;}
.split{display:flex;height:7px;border-radius:999px;overflow:hidden;background:var(--line-2);}
.split-billed{background:var(--jade);}
.split-idle{background:var(--amber);}
.split-legend{display:flex;justify-content:space-between;margin-top:9px;gap:12px;}
.legend-item{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);}
.swatch{width:9px;height:9px;border-radius:3px;flex:none;}
.row.is-idle .row-amt{color:var(--amber);}

/* task picker */
.picker{display:flex;gap:9px;align-items:flex-end;margin-top:20px;flex-wrap:wrap;}
.picker > label{flex:1;min-width:170px;margin:0;}
.picker .inp{margin:0;}
.task-chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);
  font-size:11.5px;color:var(--muted);background:var(--line-2);border-radius:999px;
  padding:3px 10px;margin-top:9px;}
.face.idle .task-chip{background:var(--amber-soft);color:var(--amber);}

/* per-task breakdown */
.trow{display:grid;grid-template-columns:1fr auto auto;gap:14px;align-items:baseline;
  padding:13px 0;border-bottom:1px solid var(--line-2);}
.trow:first-child{padding-top:0;}
.trow:last-child{border-bottom:0;padding-bottom:0;}
.trow-label{font-weight:600;font-size:14.5px;}
.trow-sub{font-size:11.5px;color:var(--muted);margin-top:4px;font-family:var(--mono);}
.trow-sub.idle{color:var(--amber);}
.trow-time{font-family:var(--mono);font-size:13px;color:var(--muted);
  font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;}
.trow-amt{font-family:var(--mono);font-size:15px;color:var(--ink);
  font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;}
.trow.none .trow-label{color:var(--muted);font-weight:500;}

/* collapsible sections */
.toggle{display:flex;align-items:center;gap:7px;background:none;border:0;padding:6px 4px;
  cursor:pointer;color:var(--muted);font-family:inherit;font-weight:600;font-size:13px;
  border-radius:6px;}
.toggle:hover{color:var(--jade);}
.chev{display:inline-block;transition:transform .18s ease;font-size:10px;}
.chev.open{transform:rotate(90deg);}
.tag{display:inline-block;font-size:10px;font-weight:600;text-transform:uppercase;
  letter-spacing:.08em;padding:2px 7px;border-radius:999px;background:var(--amber-soft);
  color:var(--amber);margin-left:8px;vertical-align:1px;}

.money{display:flex;align-items:baseline;gap:2px;color:var(--ink);line-height:.92;}
.money-head{font-family:var(--mono);font-weight:500;font-size:clamp(38px,11vw,62px);
  font-variant-numeric:tabular-nums;letter-spacing:-.035em;}
.money-tail{font-family:var(--mono);font-weight:400;font-size:clamp(19px,5vw,28px);
  color:var(--muted);font-variant-numeric:tabular-nums;}
.clock{margin-top:14px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}
.clock-main{font-family:var(--mono);font-size:22px;font-variant-numeric:tabular-nums;color:var(--ink-2);}
.clock-note{font-size:12px;color:var(--muted);}

/* signature: the minute rail — one mark per minute of the current billable hour */
.rail{display:flex;gap:2px;margin-top:24px;height:20px;align-items:flex-end;}
.tick{flex:1;background:var(--line);border-radius:2px;height:6px;transition:height .25s,background .25s;}
.tick.filled{background:var(--jade-soft);height:11px;}
.tick.head{background:var(--jade);height:20px;animation:breathe 2s ease-in-out infinite;}
.tick.q{height:13px;}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.35}}
.rail-legend{display:flex;justify-content:space-between;margin-top:9px;}

.controls{display:flex;gap:9px;margin-top:22px;flex-wrap:wrap;}
.btn{font-family:inherit;font-weight:600;font-size:14px;padding:12px 20px;border-radius:9px;
  border:1px solid var(--line);background:var(--card);color:var(--ink);
  cursor:pointer;flex:1;min-width:112px;transition:background .15s,border-color .15s,color .15s;}
.btn:hover{background:var(--raise);border-color:#D3DAD2;}
.btn.primary{background:var(--jade);color:#fff;border-color:var(--jade);}
.btn.primary:hover{background:var(--jade-hi);border-color:var(--jade-hi);}
.btn.ghost{background:var(--card);}
.btn.danger{color:var(--flag);border-color:#EBD7D4;background:var(--card);}
.btn.danger:hover{background:var(--flag-soft);border-color:var(--flag);}
.btn:disabled{opacity:.4;cursor:not-allowed;}

/* generic panels */
.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;
  padding:20px;box-shadow:var(--shadow);}
.stack{display:flex;flex-direction:column;gap:10px;}
.sec{margin-top:30px;}
.sec-head{display:flex;justify-content:space-between;align-items:center;
  padding-bottom:10px;margin-bottom:12px;}

/* goals */
.goal + .goal{margin-top:20px;}
.goal-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;gap:10px;}
.goal-val{font-family:var(--mono);font-size:13px;color:var(--ink-2);}
.bar{height:7px;background:var(--line-2);border-radius:999px;overflow:hidden;}
.bar-fill{height:100%;background:var(--jade);border-radius:999px;transition:width .5s ease;}
.bar-fill.done{background:var(--jade-hi);}

/* ledger */
.row{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;
  padding:13px 0;border-bottom:1px solid var(--line-2);}
.row:first-child{padding-top:0;}
.row:last-child{border-bottom:0;padding-bottom:0;}
.row-when{font-size:14px;font-weight:500;}
.row-meta{font-size:11.5px;color:var(--muted);margin-top:3px;font-family:var(--mono);}
.row-amt{font-family:var(--mono);font-size:15px;color:var(--ink);
  font-variant-numeric:tabular-nums;}
.x{background:none;border:0;color:#B4BEB8;cursor:pointer;font-size:18px;
  line-height:1;padding:6px 5px;border-radius:6px;}
.x:hover{color:var(--flag);background:var(--flag-soft);}

/* project cards */
.card{display:flex;justify-content:space-between;align-items:center;gap:14px;width:100%;
  text-align:left;background:var(--card);border:1px solid var(--line);border-radius:14px;
  padding:18px 20px;cursor:pointer;color:inherit;font:inherit;
  box-shadow:var(--shadow);transition:border-color .15s,transform .15s;}
.card:hover{border-color:#CBD6CE;transform:translateY(-1px);}
.card > span{display:block;min-width:0;}
.card-name{display:block;font-weight:700;font-size:17px;letter-spacing:-.015em;}
.card-meta{display:block;font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-top:5px;}
.card-amt{display:block;font-family:var(--mono);font-size:17px;color:var(--ink);
  font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;}
.card-dur{display:block;font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-top:5px;text-align:right;}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--jade);
  margin-right:8px;vertical-align:middle;animation:breathe 2s ease-in-out infinite;}

/* forms */
.field{display:block;margin-bottom:14px;}
.field > span{display:block;margin-bottom:7px;}
.inp{width:100%;background:var(--raise);border:1px solid var(--line);border-radius:9px;
  padding:11px 13px;color:var(--ink);font-family:var(--mono);font-size:14px;}
.inp:focus{border-color:var(--jade);background:var(--card);outline:none;}
.pair{display:flex;gap:10px;}
.pair > *{flex:1;}
.hint{font-size:12.5px;color:var(--muted);line-height:1.55;margin-top:-4px;margin-bottom:14px;}

.empty{text-align:center;padding:34px 16px;color:var(--muted);font-size:13.5px;line-height:1.6;}

/* banners + toast */
.banner{border:1px solid #E7DCC4;background:#FDF8EC;border-radius:14px;
  padding:18px;margin-bottom:20px;}
.banner p{margin:9px 0 0;font-size:13.5px;line-height:1.6;color:var(--ink-2);}
.banner .controls{margin-top:15px;}
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:50;
  background:var(--ink);color:#F1F3EF;border-radius:11px;
  padding:13px 16px;display:flex;align-items:center;gap:16px;font-size:13.5px;
  box-shadow:0 12px 32px rgba(16,22,19,.22);max-width:calc(100% - 32px);}
.toast .linkbtn{color:#8FD9BB;}
.toast .linkbtn:hover{color:#fff;}
.grand{margin-bottom:28px;}
.grand-amt{font-family:var(--mono);font-size:clamp(32px,8.5vw,46px);color:var(--ink);
  font-variant-numeric:tabular-nums;line-height:1.05;margin-top:8px;letter-spacing:-.035em;}
.err{color:var(--flag);font-size:12.5px;margin-top:8px;}

@media (prefers-reduced-motion: reduce){
  .mtr *{animation:none !important;transition:none !important;}
}
@media (max-width:420px){
  .btn{min-width:0;padding:12px 13px;font-size:13px;}
  .mtr{padding:20px 12px 90px;}
}
`;
