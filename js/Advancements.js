export class AdvancementEvents {
  constructor(){ this.map=new Map(); }
  on(name,fn){ if(!this.map.has(name)) this.map.set(name,[]); this.map.get(name).push(fn); }
  emit(name,payload={}){ for(const fn of this.map.get(name)||[]) fn(payload); }
}

export const ADVANCEMENTS = [
{id:'first_race',category:'beginner',title:'Baby Steps',description:'Finish your first race.',event:'race_finished',hidden:false,prerequisite:null,notify:'ADVANCEMENT MADE!\n“Baby Steps”'},
{id:'first_drift',category:'beginner',title:'Now We’re Sliding',description:'Start drifting for the first time.',event:'drift_started',hidden:false,prerequisite:null,notify:'ADVANCEMENT MADE!\n“Now We’re Sliding”'},
{id:'high_speed_150',category:'beginner',title:'Fast Enough?',description:'Reach 320 speed.',event:'top_speed_updated',hidden:false,prerequisite:null,notify:'ADVANCEMENT MADE!\n“Fast Enough?”'},
{id:'first_reset',category:'beginner',title:'Oops.',description:'Use instant reset for the first time.',event:'player_respawned',hidden:false,prerequisite:null,notify:'ADVANCEMENT MADE!\n“Oops.”'},
{id:'clean_finish',category:'beginner',title:'Nice And Easy',description:'Finish a race without crashing.',event:'race_finished',hidden:false,prerequisite:'first_race',notify:'ADVANCEMENT MADE!\n“Nice And Easy”'},
{id:'beat_ghost',category:'competition',title:'Who Needs Friends?',description:'Beat a ghost replay.',event:'ghost_beaten',hidden:false,prerequisite:'first_race',notify:'ADVANCEMENT MADE!\n“Who Needs Friends?”'},
{id:'pb_improved',category:'competition',title:'Again.',description:'Beat your own personal best.',event:'personal_best_improved',hidden:false,prerequisite:'first_race',notify:'ADVANCEMENT MADE!\n“Again.”'},
{id:'totd_done',category:'competition',title:'Daily Grind',description:'Finish the Track of the Day.',event:'totd_completed',hidden:false,prerequisite:'first_race',notify:'ADVANCEMENT MADE!\n“Daily Grind”'},
{id:'community_map',category:'community',title:'Beyond The Circuit',description:'Play a custom community map.',event:'community_map_loaded',hidden:false,prerequisite:null,notify:'ADVANCEMENT MADE!\n“Beyond The Circuit”'},
{id:'map_upload',category:'community',title:'Now Hiring',description:'Upload your first map.',event:'map_uploaded',hidden:false,prerequisite:null,notify:'ADVANCEMENT MADE!\n“Now Hiring”'},
{id:'club_join',category:'community',title:'Found Your Crew',description:'Join a club.',event:'club_joined',hidden:false,prerequisite:null,notify:'ADVANCEMENT MADE!\n“Found Your Crew”'},
{id:'trigger_used',category:'modding',title:'It’s Alive',description:'Activate a trigger block.',event:'trigger_zone_entered',hidden:false,prerequisite:null,notify:'ADVANCEMENT MADE!\n“It’s Alive”'},
{id:'modded_map',category:'modding',title:'Something Feels Different',description:'Play a map using custom mod blocks.',event:'modded_map_loaded',hidden:false,prerequisite:null,notify:'ADVANCEMENT MADE!\n“Something Feels Different”'},
{id:'reset_25',category:'secret',title:'Professional Driver',description:'Reset 25 times in one session.',event:'player_respawned',hidden:true,prerequisite:'first_reset',notify:'ADVANCEMENT MADE!\n“Professional Driver”'},
{id:'drift_10s',category:'secret',title:'Tokyo Maybe',description:'Maintain a continuous drift for 10 seconds.',event:'drift_ended',hidden:true,prerequisite:'first_drift',notify:'ADVANCEMENT MADE!\n“Tokyo Maybe”'},
];

export class AdvancementManager {
  constructor(events,opts={}){ this.events=events; this.state=opts.state||{}; this.onUnlock=opts.onUnlock||(()=>{}); this.accountDirtyRef=opts.accountDirtyRef||{value:false}; this.session={resets:0,driftStart:null,topSpeed:0,crashed:false}; this.bind(); }
  done(id){return Boolean(this.state[id]?.unlocked);} unlock(id){ if(this.done(id)) return; this.state[id]={unlocked:true,unlockedAt:Date.now()}; this.accountDirtyRef.value=true; this.onUnlock(ADVANCEMENTS.find(a=>a.id===id)); }
  bind(){ this.events.on('race_finished',(p)=>{this.unlock('first_race'); if(p?.crashed===false) this.unlock('clean_finish');}); this.events.on('drift_started',()=>{this.session.driftStart=performance.now(); this.unlock('first_drift');}); this.events.on('drift_ended',()=>{ if(this.session.driftStart){ const d=(performance.now()-this.session.driftStart)/1000; if(d>=10) this.unlock('drift_10s'); this.session.driftStart=null; }});
    this.events.on('top_speed_updated',(p)=>{ if((p?.speed||0)>=320) this.unlock('high_speed_150');}); this.events.on('player_respawned',()=>{this.unlock('first_reset'); this.session.resets++; if(this.session.resets>=25) this.unlock('reset_25');});
    this.events.on('ghost_beaten',()=>this.unlock('beat_ghost')); this.events.on('personal_best_improved',()=>this.unlock('pb_improved')); this.events.on('totd_completed',()=>this.unlock('totd_done')); this.events.on('community_map_loaded',()=>this.unlock('community_map')); this.events.on('map_uploaded',()=>this.unlock('map_upload')); this.events.on('club_joined',()=>this.unlock('club_join')); this.events.on('trigger_zone_entered',()=>this.unlock('trigger_used')); this.events.on('modded_map_loaded',()=>this.unlock('modded_map')); }
}
