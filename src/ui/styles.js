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
  /* The page asks for the whole screen with viewport-fit=cover, which puts the
     notch and the gesture bar OVER the content unless it pays them back. The
     shorthand above stays as the fallback: a browser without env() drops these
     four and keeps it. */
  padding-top:calc(26px + env(safe-area-inset-top));
  padding-right:calc(16px + env(safe-area-inset-right));
  padding-bottom:calc(96px + env(safe-area-inset-bottom));
  padding-left:calc(16px + env(safe-area-inset-left));
}
.mtr *{box-sizing:border-box;}
.mtr :focus-visible{outline:2px solid var(--jade); outline-offset:2px;}
.wrap{max-width:720px;margin:0 auto;}
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
.prompt{margin-top:20px;padding:18px;border:1px solid var(--line);border-radius:12px;
  background:var(--raise);}
.prompt .controls{margin-top:16px;}
.prompt .field{margin-bottom:0;margin-top:14px;}
.seg{display:flex;gap:6px;margin-top:12px;}
.seg-btn{flex:1;font-family:inherit;font-weight:600;font-size:13px;padding:9px 12px;
  border-radius:8px;border:1px solid var(--line);background:var(--card);
  color:var(--muted);cursor:pointer;}
.seg-btn.on{background:var(--jade-soft);border-color:var(--jade);color:var(--jade);}
.seg-btn:disabled{opacity:.4;cursor:not-allowed;}

/* ledger selection + filtering */
.selbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:13px 16px;
  border:1px solid var(--jade);background:var(--jade-soft);border-radius:11px;
  margin-bottom:12px;}
.selbar-count{font-weight:600;font-size:13.5px;color:var(--jade);flex:1;min-width:110px;}
.selbar .btn{flex:0 0 auto;min-width:0;padding:9px 14px;font-size:13px;}
.chip{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;
  background:var(--jade-soft);color:var(--jade);border-radius:999px;padding:5px 12px;
  border:0;cursor:pointer;font-family:inherit;}
.chip:hover{background:#CDE9DC;}
.row.sel{background:var(--jade-soft);}
.row-check{width:18px;height:18px;accent-color:var(--jade);cursor:pointer;flex:none;}
.row.pick{grid-template-columns:auto 1fr auto auto;}
.preview{margin-top:16px;padding:14px 15px;border-radius:10px;background:var(--card);
  border:1px solid var(--line);}
.preview-line{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-top:7px;}
.preview-now{font-family:var(--mono);font-size:19px;font-variant-numeric:tabular-nums;
  color:var(--jade);}
.preview-was{font-family:var(--mono);font-size:12.5px;color:var(--muted);
  text-decoration:line-through;}
/* The same muted figure without the strike: a correction shows what a number
   WAS, but a new entry has no superseded value to cross out. */
.preview-note{font-family:var(--mono);font-size:12.5px;color:var(--muted);}
.edited{display:inline-block;font-size:10px;font-weight:600;text-transform:uppercase;
  letter-spacing:.08em;padding:2px 7px;border-radius:999px;background:var(--line-2);
  color:var(--muted);margin-left:8px;vertical-align:1px;}
.finder{display:flex;align-items:center;gap:10px;margin:0 0 12px;}
.find{flex:1;min-width:0;padding:11px 13px;border:1px solid var(--line);border-radius:10px;
  background:var(--card);color:var(--ink);font:inherit;font-size:14px;}
.find:focus{outline:none;border-color:var(--jade);}
.find::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none;}
.find-clear{font-size:12.5px;flex:0 0 auto;}

.rhy-read{font-size:13px;color:var(--ink-2);line-height:1.5;margin-bottom:14px;}
.rhy-read strong{color:var(--ink);font-weight:700;}
.rhy-span{display:block;margin-top:2px;font-size:11.5px;color:var(--muted);}
.cyc{margin-bottom:14px;}
.cyc-bars{display:flex;align-items:flex-end;gap:3px;height:52px;}
.cyc-col{flex:1;min-width:0;height:100%;display:flex;align-items:flex-end;}
.cyc-bar{width:100%;min-height:2px;background:var(--jade-soft);border-radius:3px 3px 0 0;}
.cyc-col.on .cyc-bar{background:var(--jade);}
.cyc-labs{display:flex;gap:3px;margin-top:5px;}
.cyc-lab{flex:1;min-width:0;text-align:center;font-size:10px;color:var(--muted);
  font-family:var(--mono);letter-spacing:.02em;}

.concentration{margin:0 0 10px;font-size:12.5px;color:var(--ink-2);}
.concentration strong{color:var(--ink);font-weight:700;}

.sync-read{margin:0;font-size:13px;color:var(--ink-2);line-height:1.5;}
.sync-bad{color:var(--flag);}
.sync-note{margin:9px 0 0;font-size:12.5px;color:var(--muted);line-height:1.55;}
.sync-intro{margin:0 0 12px;font-size:12.5px;color:var(--muted);line-height:1.55;}
.sync-intro.last{margin-bottom:0;}
.sync-origin{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 20px;}
/* Secondary by construction: things done once and then never again should not
   sit at the same size as the button pressed every day. */
.sync-more{display:flex;align-items:center;gap:11px;margin-top:16px;}
.sync-more .linkish{font-size:12.5px;}
.sync-sep{color:var(--line);font-size:12.5px;}
.sync-foot{margin:18px 0 0;padding-top:15px;border-top:1px solid var(--line-2);
  font-size:12px;color:var(--muted);line-height:1.55;}
.origin{font-family:var(--mono);font-size:12px;background:var(--raise);
  border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:var(--ink);
  user-select:all;word-break:break-all;}

.backup-note{margin:10px 0 0;font-size:12px;color:var(--muted);}
.linkish{background:none;border:0;padding:0;font:inherit;color:var(--jade);
  cursor:pointer;text-decoration:underline;text-underline-offset:2px;}
.linkish:hover{color:var(--jade-hi);}
.trow.clickable{cursor:pointer;}
.trow.clickable:hover .trow-label{color:var(--jade);}
.trow.on .trow-label{color:var(--jade);}

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
.bar{height:7px;background:var(--line-2);border-radius:999px;overflow:hidden;position:relative;}
.bar-fill{height:100%;background:var(--jade);border-radius:999px;transition:width .5s ease;}
.bar-fill.done{background:var(--jade-hi);}
/* where the finished days say the fill should have reached */
.bar-mark{position:absolute;top:-1px;bottom:-1px;width:2px;transform:translateX(-50%);
  background:var(--ink);opacity:.4;border-radius:2px;}
.goal-pace{margin-top:9px;font-family:var(--mono);font-size:11.5px;color:var(--muted);}
.goal-pace.behind{color:var(--amber);}
.goal-pace.missed{color:var(--flag);}
.goal-pace.ahead,.goal-pace.met{color:var(--jade);}

/* targets on the overview */
.trg + .trg{margin-top:22px;padding-top:22px;border-top:1px solid var(--line-2);}
.trg-top{display:flex;align-items:baseline;gap:8px;margin-bottom:8px;}
.trg-name{font-weight:600;font-size:14.5px;color:var(--ink);text-decoration:none;}
.trg-name:hover{color:var(--jade);text-decoration:underline;}
.trg-of{font-size:11px;color:var(--muted);}
.trg-top .goal-val{margin-left:auto;}

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

/* ── tabs + reporting ─────────────────────────────────────────────────── */
.tabs{display:flex;gap:4px;background:var(--line-2);padding:3px;border-radius:10px;}
.tab{font-family:inherit;font-weight:600;font-size:13px;padding:8px 15px;border:0;
  border-radius:8px;background:none;color:var(--muted);cursor:pointer;
  transition:background .15s,color .15s;}
.tab:hover{color:var(--ink-2);}
.tab.on{background:var(--card);color:var(--ink);box-shadow:0 1px 2px rgba(16,22,19,.07);}

.dash-head{display:flex;align-items:center;justify-content:space-between;gap:12px;
  margin-bottom:24px;flex-wrap:wrap;}
.segmented{display:flex;gap:3px;background:var(--line-2);padding:3px;border-radius:9px;}
.seg{font-family:inherit;font-weight:600;font-size:12.5px;padding:7px 14px;border:0;
  border-radius:7px;background:none;color:var(--muted);cursor:pointer;}
.seg:hover{color:var(--ink-2);}
.seg.on{background:var(--card);color:var(--ink);box-shadow:0 1px 2px rgba(16,22,19,.07);}
.stepper{display:flex;gap:4px;}
.step{font-family:inherit;font-size:17px;line-height:1;width:34px;height:34px;
  border:1px solid var(--line);background:var(--card);color:var(--ink-2);
  border-radius:8px;cursor:pointer;}
.step:hover:not(:disabled){border-color:#CBD6CE;color:var(--jade);}
.step:disabled{opacity:.35;cursor:not-allowed;}

.grand-alt{font-family:var(--mono);font-size:19px;color:var(--muted);
  font-variant-numeric:tabular-nums;margin-top:5px;letter-spacing:-.02em;}
.dash-sub{margin-top:11px;font-size:12.5px;color:var(--muted);display:flex;
  align-items:center;gap:7px;flex-wrap:wrap;}

/* Deltas read as text, not as a coloured chip — the figure is the point. */
.delta{font-family:var(--mono);font-size:12.5px;font-weight:500;
  font-variant-numeric:tabular-nums;white-space:nowrap;}
.delta.up{color:var(--jade);}
.delta.down{color:var(--flag);}
.delta.flat,.delta.none{color:var(--muted);}
.delta-vs{color:var(--muted);font-weight:400;}

.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(138px,1fr));gap:10px;}
.tile{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:16px 17px;}
/* Proportional figures: tabular-nums makes a display-size number look loose. */
.tile-val{font-size:25px;font-weight:600;letter-spacing:-.03em;margin-top:9px;
  line-height:1.1;color:var(--ink);}
.tile-sub{margin-top:7px;font-size:12px;color:var(--muted);}

/* ── trend columns ───────────────────────────────────────────────────── */
.trend-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
  margin-bottom:16px;}
/* Height covers the plot only; the axis band sits below it in normal flow, so
   the labels can never be clipped by a fixed container height. */
.trend-plot{display:flex;align-items:flex-end;gap:2px;height:132px;
  border-bottom:1px solid var(--line);}
.tcol{flex:1 1 0;min-width:0;height:100%;display:flex;align-items:flex-end;
  justify-content:center;position:relative;cursor:default;}
.tbar{width:100%;max-width:24px;display:flex;flex-direction:column;
  justify-content:flex-end;height:100%;}
.tseg{border-radius:0;}
.tseg.billed{background:var(--jade);border-radius:4px 4px 0 0;min-height:2px;}
/* When idle stacks on top, the rounded data-end belongs to the idle segment and
   the 2px surface gap separates the two fills. */
.tseg.billed.under{border-radius:0;}
.tseg.idle{background:var(--amber);border-radius:4px 4px 0 0;min-height:2px;}
.tseg.idle.stacked{margin-bottom:2px;}
.tcol:hover .tbar,.tcol:focus-visible .tbar{filter:brightness(1.08);}

.trend-axis{display:flex;gap:2px;margin-top:8px;}
.tlab{flex:1 1 0;min-width:0;text-align:center;font-family:var(--mono);
  font-size:10px;color:var(--muted);white-space:nowrap;}

.ttip{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);
  background:var(--ink);color:#F1F3EF;border-radius:9px;padding:9px 11px;
  font-size:11.5px;line-height:1.55;white-space:nowrap;z-index:20;
  display:none;flex-direction:column;box-shadow:0 8px 22px rgba(16,22,19,.22);}
.ttip strong{font-weight:600;font-size:11px;letter-spacing:.02em;}
.ttip-idle{color:#E8C98A;}
.tcol:hover .ttip,.tcol:focus-within .ttip{display:flex;}
/* The first and last tooltips would otherwise spill off the panel. */
.tcol:first-child .ttip{left:0;transform:none;}
.tcol:last-child .ttip{left:auto;right:0;transform:none;}

.legend{display:flex;gap:16px;margin-top:14px;flex-wrap:wrap;}
.util-note{margin-top:9px;font-size:12px;color:var(--muted);}

/* ── per-project rows ────────────────────────────────────────────────── */
.prow{display:block;width:100%;text-align:left;background:none;border:0;
  font-family:inherit;color:inherit;cursor:pointer;padding:15px 0;
  border-bottom:1px solid var(--line-2);}
.prow:first-child{padding-top:0;}
.prow:last-child{border-bottom:0;padding-bottom:0;}
.prow-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;}
.prow-name{font-weight:600;font-size:14.5px;}
.prow:hover .prow-name{color:var(--jade);}
.prow-amt{font-family:var(--mono);font-size:14px;font-variant-numeric:tabular-nums;}
.prow-bar{display:flex;gap:2px;height:6px;margin-top:10px;border-radius:999px;
  background:var(--line-2);overflow:hidden;}
.prow-billed{background:var(--jade);border-radius:999px;}
.prow-idle{background:var(--amber);border-radius:999px;}
.prow-meta{display:block;margin-top:8px;font-family:var(--mono);font-size:11.5px;
  color:var(--muted);}

@media (max-width:420px){
  .tiles{grid-template-columns:repeat(2,1fr);}
  .delta-vs{display:none;}
  /* A project name and its figure will not share a line this narrow without
     one of them breaking mid-word. Give the figure its own. */
  .trg-top{flex-wrap:wrap;row-gap:2px;}
  .trg-top .goal-val{margin-left:0;flex-basis:100%;}
}

.segmented.small{padding:3px;}
.segmented.small .seg{padding:5px 11px;font-size:11.5px;}

/* money the clock never measured */
.grand-pending{margin-top:6px;font-family:var(--mono);font-size:13px;color:var(--amber);}
.ern{display:flex;justify-content:space-between;align-items:center;gap:12px;
  padding:13px 0;border-bottom:1px solid var(--line-2);}
.ern:first-child{padding-top:0;}
.ern:last-of-type{border-bottom:0;}
.ern-main{display:flex;flex-direction:column;gap:4px;min-width:0;}
.ern-amt{font-family:var(--mono);font-size:15px;font-variant-numeric:tabular-nums;font-weight:600;}
.ern-meta{font-family:var(--mono);font-size:11.5px;color:var(--muted);}
.ern-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;}
.inp.mini{padding:5px 7px;font-size:11.5px;width:auto;}
/* Cancelled work still happened; it is dimmed, never hidden. */
.ern.cancelled .ern-amt{text-decoration:line-through;color:var(--muted);}
.ern-form{padding-top:16px;border-top:1px solid var(--line-2);}
.ern + .ern-form,.ern + .obj-add{margin-top:4px;}

/* by company */
.crow{display:block;padding:16px 0;border-bottom:1px solid var(--line-2);}
.crow:first-child{padding-top:0;}
.crow:last-child{border-bottom:0;padding-bottom:0;}
.crow-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;}
.crow-name{font-weight:600;font-size:14.5px;}
.crow-amt{font-family:var(--mono);font-size:14px;font-variant-numeric:tabular-nums;}
.crow-bar{display:block;height:6px;margin-top:10px;border-radius:999px;
  background:var(--line-2);overflow:hidden;}
.crow-fill{display:block;height:100%;background:var(--jade);border-radius:999px;}
.crow-meta{display:block;margin-top:8px;font-family:var(--mono);font-size:11.5px;
  color:var(--muted);}
/* Unassigned is a gap to fill, not a client to rank. */
.crow.none .crow-name{color:var(--muted);font-weight:500;}
.crow.none .crow-fill{background:var(--muted);}

/* activity calendar */
.hm{--hm-cell:10px;--hm-gap:2px;--hm-pitch:12px;}
.hm-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:14px;}
.hm-span{text-transform:none;letter-spacing:0;font-family:var(--mono);font-size:10.5px;}
/* The register toggle and the year stepper share the heading's right side. */
.hm-head{display:flex;align-items:center;gap:10px;}
/* 53 columns will not fit a phone. Scrolling keeps the cells legible instead
   of shrinking them to a size nothing can be aimed at. */
.hm-scroll{overflow-x:auto;padding-bottom:4px;}
.hm-months,.hm-body{min-width:calc(var(--hm-pitch) * 53);}
.hm-months{display:flex;gap:6px;margin-bottom:5px;height:12px;}
.hm-gutter{position:sticky;left:0;flex:0 0 28px;background:var(--card);z-index:2;}
.hm-months .hm-month:first-of-type{margin-left:0;}
.hm-month{flex:0 0 var(--hm-cell);font-family:var(--mono);font-size:10px;color:var(--muted);
  white-space:nowrap;overflow:visible;margin-right:calc(var(--hm-gap) - 6px);}
.hm-body{display:flex;gap:6px;}
/* Pinned, so the rows stay named when the calendar is scrolled sideways. */
.hm-days{display:flex;flex-direction:column;gap:var(--hm-gap);width:28px;flex:0 0 28px;
  position:sticky;left:0;background:var(--card);z-index:2;}
.hm-day{height:var(--hm-cell);line-height:var(--hm-cell);font-family:var(--mono);
  font-size:9.5px;color:var(--muted);}
.hm-grid{display:flex;gap:var(--hm-gap);}
.hm-col{display:flex;flex-direction:column;gap:var(--hm-gap);}
.hm-cell{width:var(--hm-cell);height:var(--hm-cell);border-radius:2px;display:block;}
.hm-cell.future{background:transparent;}
.hm-cell:not(.future):hover{outline:1.5px solid var(--ink);outline-offset:1px;}
.hm-read{text-align:right;text-transform:none;letter-spacing:0;font-family:var(--mono);
  font-size:11px;line-height:1.5;}
.hm-read.on{color:var(--ink-2);}
.hm-legend{margin-top:16px;gap:14px;}
.hm-legend .legend-item{font-family:var(--mono);font-size:11px;}
.hm-none{margin-top:14px;font-size:12.5px;color:var(--muted);}

/* paused and done */
.plate-for{font-size:12.5px;color:var(--muted);margin-top:2px;}
.plate-name .tag{vertical-align:3px;}
.card.stopped{opacity:.72;}
.card.stopped:hover{opacity:1;}
.done-head{display:flex;align-items:center;gap:8px;background:none;border:0;padding:10px 0;
  cursor:pointer;font:inherit;color:var(--muted);width:100%;text-align:left;}
.done-head:hover{color:var(--ink-2);}
.tiles.closing{margin-top:0;}

/* Off the clock: a third, deliberately quiet register. Slate rather than a
   fourth accent — this time is context, not a series competing with the two
   that carry money. */
.prow-off{background:var(--muted);border-radius:999px;}
.prow.off .prow-amt{font-family:var(--mono);color:var(--ink-2);}
.card.off{background:var(--raise);}
.card.off .card-amt{color:var(--ink-2);}
.card.off .card-meta{font-style:normal;}
.card.off .dot{background:var(--muted);}

/* ── objectives ──────────────────────────────────────────────────────── */
.obj{display:grid;grid-template-columns:1fr auto;gap:6px 14px;align-items:baseline;
  padding:14px 0;border-bottom:1px solid var(--line-2);}
.obj:first-child{padding-top:0;}
.obj:last-of-type{border-bottom:0;}
.obj-check{display:flex;align-items:flex-start;gap:11px;cursor:pointer;margin:0;min-width:0;}
.obj-check input{width:17px;height:17px;flex:none;margin:1px 0 0;accent-color:var(--jade);
  cursor:pointer;}
.obj-text{font-size:14.5px;font-weight:500;line-height:1.45;}
/* Struck through and faded, so finished work stays visible as a record of the
   day without competing with what is still outstanding. */
.obj.done .obj-text{text-decoration:line-through;color:var(--muted);font-weight:400;}
.obj-meta{grid-column:1;display:flex;gap:12px;flex-wrap:wrap;margin-left:28px;
  font-family:var(--mono);font-size:11.5px;color:var(--muted);}
.obj-untimed{opacity:.75;}
.obj-verdict.over{color:var(--flag);}
.obj-verdict.under,.obj-verdict.on{color:var(--jade);}
.obj-actions{grid-row:1;grid-column:2;display:flex;align-items:center;gap:10px;}
.obj-actions .linkish{font-size:11.5px;}
.obj-actions .linkish[aria-pressed="true"]{color:var(--jade);font-weight:700;}
.obj-form{padding-top:16px;border-top:1px solid var(--line-2);margin-top:4px;}
.obj-add{margin-top:14px;font-size:13px;}

/* A clash is a warning, not an error — it states what would be double-counted
   and lets you decide, rather than refusing and leaving you stuck. */
.clash{border:1px solid #E7DCC4;background:#FDF8EC;border-radius:12px;
  padding:15px;margin-top:14px;}
.clash p{margin:8px 0 0;font-size:13px;line-height:1.55;color:var(--ink-2);}
.clash ul{margin:10px 0 0;padding-left:18px;font-family:var(--mono);font-size:11.5px;
  color:var(--muted);line-height:1.8;}
.clash-ok{display:flex;align-items:center;gap:9px;margin-top:12px;font-size:13px;
  font-weight:600;cursor:pointer;}
.clash-ok input{width:16px;height:16px;accent-color:var(--flag);cursor:pointer;}

@media (prefers-reduced-motion: reduce){
  .mtr *{animation:none !important;transition:none !important;}
}
@media (max-width:420px){
  .btn{min-width:0;padding:12px 13px;font-size:13px;}
  .mtr{
    padding:20px 12px 90px;
    padding-top:calc(20px + env(safe-area-inset-top));
    padding-right:calc(12px + env(safe-area-inset-right));
    padding-bottom:calc(90px + env(safe-area-inset-bottom));
    padding-left:calc(12px + env(safe-area-inset-left));
  }
}
`;
