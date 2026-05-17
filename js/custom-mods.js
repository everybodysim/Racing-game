const DRAFT_KEY = 'racing-custom-mods-workspace-v2';
const SHARED_KEY = 'racing-shared-custom-mods-v1';

function setStatus(message) { const el = document.getElementById('status'); if (el) el.textContent = message; }
function safeId(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-'); }

const EVENTS = ['start','tick','checkpoint','crash','lap_finish','respawn','timer_done'];
const VEH = '#06b6d4', EVT='#f59e0b', FX='#0ea5e9', VAR='#22c55e', FLOW='#14b8a6';

Blockly.Blocks.event_on_start={init(){this.appendStatementInput('DO').appendField('when race starts');this.setColour(EVT);}};
Blockly.Blocks.event_on_tick={init(){this.appendStatementInput('DO').appendField('every tick');this.setColour(EVT);}};
Blockly.Blocks.event_on_key={init(){this.appendDummyInput().appendField('when key').appendField(new Blockly.FieldDropdown([['W','KeyW'],['A','KeyA'],['S','KeyS'],['D','KeyD'],['Space','Space']]),'KEY').appendField('pressed');this.appendStatementInput('DO').appendField('do');this.setColour(EVT);}};
Blockly.Blocks.event_on_checkpoint={init(){this.appendStatementInput('DO').appendField('on checkpoint reached');this.setColour(EVT);}};
Blockly.Blocks.event_on_crash={init(){this.appendStatementInput('DO').appendField('on crash');this.setColour(EVT);}};
Blockly.Blocks.event_on_lap_finish={init(){this.appendStatementInput('DO').appendField('on finish/lap');this.setColour(EVT);}};
Blockly.Blocks.event_on_respawn={init(){this.appendStatementInput('DO').appendField('on respawn/reset');this.setColour(EVT);}};
Blockly.Blocks.event_on_timer_done={init(){this.appendDummyInput().appendField('on timer done').appendField(new Blockly.FieldTextInput('timer1'),'ID');this.appendStatementInput('DO').appendField('do');this.setColour(EVT);}};

const actionDef=(name,field,label,color=VEH)=>Blockly.Blocks[name]={init(){if(field)this.appendValueInput(field).setCheck('Number').appendField(label);else this.appendDummyInput().appendField(label);this.setPreviousStatement(true);this.setNextStatement(true);this.setColour(color);}};
actionDef('action_set_speed','SPEED','set max speed');
actionDef('action_boost','AMOUNT','boost by');
actionDef('action_set_gravity','G','set gravity');
actionDef('action_set_time_scale','SCALE','set time scale');
actionDef('action_set_accel_mult','VALUE','set acceleration multiplier');
actionDef('action_set_drive_mult','VALUE','set boost/drive multiplier');
actionDef('action_set_grip_mult','VALUE','set drift/grip multiplier');
actionDef('action_force_brake','TIME','force brake for seconds');
actionDef('action_force_throttle','TIME','force throttle for seconds');
actionDef('action_disable_steering','TIME','disable steering for seconds');
actionDef('action_jump','POWER','jump power');
actionDef('action_reset_car',null,'respawn vehicle');
actionDef('action_show_message','TEXT','display message',FX);
actionDef('action_spawn_particle',null,'spawn smoke fx',FX);
actionDef('action_camera_shake','INT','camera shake',FX);
actionDef('action_set_fog_strength','VALUE','set fog intensity (0-2)',FX);
actionDef('action_start_timer','SECS','start timer seconds',FLOW);
actionDef('action_wait','SECS','wait seconds',FLOW);
Blockly.Blocks.action_random_delay={init(){this.appendValueInput('MIN').setCheck('Number').appendField('random delay min');this.appendValueInput('MAX').setCheck('Number').appendField('max');this.setPreviousStatement(true);this.setNextStatement(true);this.setColour(FLOW);}};
Blockly.Blocks.action_var_set={init(){this.appendDummyInput().appendField('set variable').appendField(new Blockly.FieldTextInput('score'),'NAME');this.appendValueInput('VALUE').setCheck('Number').appendField('to');this.setPreviousStatement(true);this.setNextStatement(true);this.setColour(VAR);}};
Blockly.Blocks.action_var_add={init(){this.appendDummyInput().appendField('add variable').appendField(new Blockly.FieldTextInput('score'),'NAME');this.appendValueInput('VALUE').setCheck('Number').appendField('by');this.setPreviousStatement(true);this.setNextStatement(true);this.setColour(VAR);}};
Blockly.Blocks.value_var_get={init(){this.appendDummyInput().appendField('variable').appendField(new Blockly.FieldTextInput('score'),'NAME');this.setOutput(true,'Number');this.setColour(VAR);}};
Blockly.Blocks.value_speed={init(){this.appendDummyInput().appendField('current speed');this.setOutput(true,'Number');this.setColour(VAR);}};
Blockly.Blocks.value_lap_time={init(){this.appendDummyInput().appendField('lap time');this.setOutput(true,'Number');this.setColour(VAR);}};
Blockly.Blocks.value_checkpoint_number={init(){this.appendDummyInput().appendField('checkpoint number');this.setOutput(true,'Number');this.setColour(VAR);}};
Blockly.Blocks.value_crash_force={init(){this.appendDummyInput().appendField('crash force');this.setOutput(true,'Number');this.setColour(VAR);}};
Blockly.Blocks.value_random={init(){this.appendDummyInput().appendField('random 0 to 1');this.setOutput(true,'Number');this.setColour(VAR);}};

const workspace = Blockly.inject('blocklyDiv',{toolbox:document.getElementById('toolbox'),trashcan:true,zoom:{controls:true,wheel:true,startScale:0.95}});
const textToDom = (text)=> (Blockly.utils?.xml?.textToDom ? Blockly.utils.xml.textToDom(text) : Blockly.Xml.textToDom(text));
function exportXmlPretty(){return Blockly.Xml.domToPrettyText(Blockly.Xml.workspaceToDom(workspace));}
function loadXmlText(text){Blockly.Xml.clearWorkspaceAndLoadFromXml(textToDom(text),workspace);}

function parseValueBlock(block){if(!block)return null; if(block.type==='math_number')return Number(block.getFieldValue('NUM'))||0; if(block.type==='text')return String(block.getFieldValue('TEXT')||''); if(block.type==='math_arithmetic')return{kind:'math',op:block.getFieldValue('OP'),a:parseValueBlock(block.getInputTargetBlock('A'))??0,b:parseValueBlock(block.getInputTargetBlock('B'))??0}; if(block.type==='value_speed')return{kind:'runtime',name:'speed'}; if(block.type==='value_lap_time')return{kind:'runtime',name:'lapTime'}; if(block.type==='value_checkpoint_number')return{kind:'runtime',name:'checkpointNumber'}; if(block.type==='value_crash_force')return{kind:'runtime',name:'crashForce'}; if(block.type==='value_random')return{kind:'runtime',name:'random'}; if(block.type==='value_var_get')return{kind:'var',name:safeId(block.getFieldValue('NAME')||'var')}; return null;}

function parseActionStatement(block){if(!block)return null;const v=(n,d=0)=>parseValueBlock(block.getInputTargetBlock(n))??d;
if(block.type==='action_set_speed')return{type:'set_speed',value:v('SPEED')}; if(block.type==='action_boost')return{type:'boost',value:v('AMOUNT')}; if(block.type==='action_set_gravity')return{type:'set_gravity',value:v('G',9.81)}; if(block.type==='action_set_time_scale')return{type:'set_time_scale',value:v('SCALE',1)};
if(block.type==='action_set_accel_mult')return{type:'set_accel_mult',value:v('VALUE',1)}; if(block.type==='action_set_drive_mult')return{type:'set_drive_mult',value:v('VALUE',1)}; if(block.type==='action_set_grip_mult')return{type:'set_grip_mult',value:v('VALUE',1)};
if(block.type==='action_force_brake')return{type:'force_brake',value:v('TIME',0.4)}; if(block.type==='action_force_throttle')return{type:'force_throttle',value:v('TIME',0.4)}; if(block.type==='action_disable_steering')return{type:'disable_steering',value:v('TIME',0.5)};
if(block.type==='action_jump')return{type:'jump',value:v('POWER',6)}; if(block.type==='action_reset_car')return{type:'reset_car'}; if(block.type==='action_show_message')return{type:'show_message',value:v('TEXT','')}; if(block.type==='action_spawn_particle')return{type:'spawn_particle'}; if(block.type==='action_camera_shake')return{type:'camera_shake',value:v('INT',1)};
if(block.type==='action_set_fog_strength')return{type:'set_fog_strength',value:v('VALUE',1)}; if(block.type==='action_start_timer')return{type:'start_timer',value:v('SECS',1)}; if(block.type==='action_wait')return{type:'wait',value:v('SECS',0.2)}; if(block.type==='action_random_delay')return{type:'random_delay',min:v('MIN',0),max:v('MAX',1)};
if(block.type==='action_var_set')return{type:'var_set',name:safeId(block.getFieldValue('NAME')||'var'),value:v('VALUE',0)}; if(block.type==='action_var_add')return{type:'var_add',name:safeId(block.getFieldValue('NAME')||'var'),value:v('VALUE',0)};
return null;}
function parseStatementChain(first){const out=[];let c=first;while(c){const p=parseActionStatement(c);if(p)out.push(p);c=c.getNextBlock();}return out;}
function buildRuntimeSpec(){const spec={onStart:[],onTick:[],onKey:{},onCheckpoint:[],onCrash:[],onLapFinish:[],onRespawn:[],onTimerDone:{}};for(const block of workspace.getTopBlocks(true)){if(block.type==='event_on_start')spec.onStart.push(...parseStatementChain(block.getInputTargetBlock('DO')));if(block.type==='event_on_tick')spec.onTick.push(...parseStatementChain(block.getInputTargetBlock('DO')));if(block.type==='event_on_checkpoint')spec.onCheckpoint.push(...parseStatementChain(block.getInputTargetBlock('DO')));if(block.type==='event_on_crash')spec.onCrash.push(...parseStatementChain(block.getInputTargetBlock('DO')));if(block.type==='event_on_lap_finish')spec.onLapFinish.push(...parseStatementChain(block.getInputTargetBlock('DO')));if(block.type==='event_on_respawn')spec.onRespawn.push(...parseStatementChain(block.getInputTargetBlock('DO')));if(block.type==='event_on_key'){const k=block.getFieldValue('KEY')||'KeyW';spec.onKey[k]=[...(spec.onKey[k]||[]),...parseStatementChain(block.getInputTargetBlock('DO'))];}if(block.type==='event_on_timer_done'){const id=safeId(block.getFieldValue('ID')||'timer1');spec.onTimerDone[id]=[...(spec.onTimerDone[id]||[]),...parseStatementChain(block.getInputTargetBlock('DO'))];}}
return spec;}

function renderActionsRuntimeCode(){return `
function resolveValue(value, ctx, event = {}) {
  if (value && typeof value === 'object') {
    if (value.kind === 'runtime') {
      if (value.name === 'speed') return Math.abs(Number(ctx?.vehicle?.linearSpeed) || 0);
      if (value.name === 'lapTime') return Number(event.lapTime ?? event.now) || 0;
      if (value.name === 'checkpointNumber') return Number(event.checkpointNumber) || 0;
      if (value.name === 'crashForce') return Number(event.impactVelocity) || 0;
      if (value.name === 'random') return Math.random();
    }
    if (value.kind === 'var') return Number(ctx?.state?.vars?.[value.name]) || 0;
    if (value.kind === 'math') { const a = Number(resolveValue(value.a, ctx, event)) || 0; const b = Number(resolveValue(value.b, ctx, event)) || 0; if (value.op === 'ADD') return a + b; if (value.op === 'MINUS') return a - b; if (value.op === 'MULTIPLY') return a * b; if (value.op === 'DIVIDE') return b === 0 ? 0 : a / b; }
  }
  return value;
}
function runActions(actions, ctx, event = {}) {
  const api = ctx?.api || {};
  if (!ctx.state) ctx.state = { vars: {}, timers: [], waits: [] };
  for (const action of actions || []) {
    if (!action || !action.type) continue;
    const value = resolveValue(action.value, ctx, event);
    if (action.type === 'set_speed' && typeof api.setSpeed === 'function') api.setSpeed(Number(value) || 0, event);
    if (action.type === 'boost' && typeof api.boost === 'function') api.boost(Number(value) || 0, event);
    if (action.type === 'set_gravity' && typeof api.setGravity === 'function') api.setGravity(Number(value) || 9.81, event);
    if (action.type === 'set_time_scale' && typeof api.setTimeScale === 'function') api.setTimeScale(Number(value) || 1, event);
    if (action.type === 'set_accel_mult' && typeof api.setAccelMultiplier === 'function') api.setAccelMultiplier(Number(value) || 1, event);
    if (action.type === 'set_drive_mult' && typeof api.setDriveMultiplier === 'function') api.setDriveMultiplier(Number(value) || 1, event);
    if (action.type === 'set_grip_mult' && typeof api.setGripMultiplier === 'function') api.setGripMultiplier(Number(value) || 1, event);
    if (action.type === 'force_brake' && typeof api.forceBrake === 'function') api.forceBrake(Number(value) || 0.4, event);
    if (action.type === 'force_throttle' && typeof api.forceThrottle === 'function') api.forceThrottle(Number(value) || 0.4, event);
    if (action.type === 'disable_steering' && typeof api.disableSteering === 'function') api.disableSteering(Number(value) || 0.5, event);
    if (action.type === 'jump' && typeof api.jump === 'function') api.jump(Number(value) || 6, event);
    if (action.type === 'reset_car' && typeof api.resetCar === 'function') api.resetCar(event);
    if (action.type === 'show_message' && typeof api.showMessage === 'function') api.showMessage(String(value ?? ''), event);
    if (action.type === 'spawn_particle' && typeof api.spawnParticle === 'function') api.spawnParticle(event);
    if (action.type === 'camera_shake' && typeof api.cameraShake === 'function') api.cameraShake(Number(value) || 1, event);
    if (action.type === 'set_fog_strength' && typeof api.setFogStrength === 'function') api.setFogStrength(Number(value) || 1, event);
    if (action.type === 'start_timer') ctx.state.timers.push({ remaining: Math.max(0, Number(value) || 0), id: 'timer1' });
    if (action.type === 'wait') ctx.state.waits.push({ remaining: Math.max(0, Number(value) || 0) });
    if (action.type === 'random_delay') { const min = Number(resolveValue(action.min, ctx, event)) || 0; const max = Number(resolveValue(action.max, ctx, event)) || min; ctx.state.waits.push({ remaining: Math.random() * (Math.max(min,max)-Math.min(min,max)) + Math.min(min,max) }); }
    if (action.type === 'var_set') ctx.state.vars[action.name] = Number(value) || 0;
    if (action.type === 'var_add') ctx.state.vars[action.name] = (Number(ctx.state.vars[action.name]) || 0) + (Number(value) || 0);
  }
}
`}

function generateTemplate(){const id=safeId(document.getElementById('mod-id')?.value)||`custom-${Date.now()}`;const name=(document.getElementById('mod-name')?.value||'Custom Mod').trim();const spec=buildRuntimeSpec();return `// ${name}\nconst SPEC = ${JSON.stringify(spec,null,2)};\n${renderActionsRuntimeCode()}\nexport default {\n  id: ${JSON.stringify(id)},\n  init(context) { this.ctx = context; this.state = { vars: {}, timers: [], waits: [] }; this.keyLatch = Object.create(null); runActions(SPEC.onStart, this.ctx, { type: 'start' }); },\n  applyFrame({ controls, vehicle, world, dt, now }) { const ctx = this.ctx || { vehicle, world, controls }; ctx.state = this.state; runActions(SPEC.onTick, ctx, { type: 'tick', dt, now }); for (const [key, actions] of Object.entries(SPEC.onKey || {})) { const down = Boolean(controls?.keys?.[key]); if (down && !this.keyLatch[key]) runActions(actions, ctx, { type: 'key', key, dt, now }); this.keyLatch[key] = down; } if (Array.isArray(this.state.timers)) { for (const t of this.state.timers) t.remaining -= dt; const done = this.state.timers.filter((t) => t.remaining <= 0); this.state.timers = this.state.timers.filter((t) => t.remaining > 0); for (const t of done) runActions((SPEC.onTimerDone && SPEC.onTimerDone[t.id]) || [], ctx, { type: 'timer_done', id: t.id, now }); } },\n  onCheckpoint(event) { runActions(SPEC.onCheckpoint, this.ctx, { type: 'checkpoint', ...(event || {}) }); },\n  onCrash(event) { runActions(SPEC.onCrash, this.ctx, { type: 'crash', ...(event || {}) }); },\n  onRespawn(event) { runActions(SPEC.onRespawn, this.ctx, { type: 'respawn', ...(event || {}) }); },\n  dispose() { this.ctx = null; this.state = null; this.keyLatch = Object.create(null); }\n};\n`;}

function toBase64Url(str){const bytes=new TextEncoder().encode(str);let bin='';bytes.forEach((b)=>{bin+=String.fromCharCode(b);});return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');}
function fromBase64Url(raw){const norm=String(raw||'').replace(/-/g,'+').replace(/_/g,'/');const padded=norm+'==='.slice((norm.length+3)%4);const bin=atob(padded);const bytes=Uint8Array.from(bin,(c)=>c.charCodeAt(0));return new TextDecoder().decode(bytes);}
function getSharePayload(){const xml=exportXmlPretty();const template=generateTemplate();return{type:'racing-custom-mod-share-v1',modId:safeId(document.getElementById('mod-id')?.value)||`custom-${Date.now()}`,modName:(document.getElementById('mod-name')?.value||'').trim()||'Custom Mod',xml,template,createdAt:new Date().toISOString()};}
function applySharePayload(payload){if(!payload||payload.type!=='racing-custom-mod-share-v1')throw new Error('Unsupported share payload');document.getElementById('mod-id').value=payload.modId||'';document.getElementById('mod-name').value=payload.modName||'';document.getElementById('xmlBox').value=payload.xml||'';if(payload.xml)loadXmlText(payload.xml);}

document.getElementById('export-xml')?.addEventListener('click',()=>{document.getElementById('xmlBox').value=exportXmlPretty();setStatus('XML exported');});
document.getElementById('import-xml')?.addEventListener('click',()=>{try{loadXmlText(document.getElementById('xmlBox').value);setStatus('XML imported');}catch{setStatus('Invalid XML');}});
document.getElementById('export-template')?.addEventListener('click',()=>{document.getElementById('xmlBox').value=generateTemplate();setStatus('JS template generated');});
document.getElementById('save-draft')?.addEventListener('click',()=>{localStorage.setItem(DRAFT_KEY,JSON.stringify({modId:document.getElementById('mod-id').value,modName:document.getElementById('mod-name').value,xml:exportXmlPretty()}));setStatus('Draft saved');});
document.getElementById('load-draft')?.addEventListener('click',()=>{const raw=localStorage.getItem(DRAFT_KEY);if(!raw)return setStatus('No draft found');const p=JSON.parse(raw);document.getElementById('mod-id').value=p.modId||'';document.getElementById('mod-name').value=p.modName||'';document.getElementById('xmlBox').value=p.xml||'';if(p.xml)loadXmlText(p.xml);setStatus('Draft loaded');});
document.getElementById('export-share')?.addEventListener('click',async()=>{const packed=toBase64Url(JSON.stringify(getSharePayload()));const url=`${location.origin}${location.pathname}?share=${encodeURIComponent(packed)}`;document.getElementById('xmlBox').value=url;try{await navigator.clipboard.writeText(url);setStatus('Share URL copied');}catch{setStatus('Share URL generated');}});
document.getElementById('save-to-manager')?.addEventListener('click',()=>{const payload=getSharePayload();const arr=JSON.parse(localStorage.getItem(SHARED_KEY)||'[]').filter((x)=>x.modId!==payload.modId);arr.push(payload);localStorage.setItem(SHARED_KEY,JSON.stringify(arr));setStatus('Saved to Mod Manager imports');});
const shareParam=new URLSearchParams(location.search).get('share');if(shareParam){try{applySharePayload(JSON.parse(fromBase64Url(shareParam)));setStatus('Loaded shared mod from URL');}catch{setStatus('Invalid shared URL payload');}}else setStatus('Workspace loaded');
