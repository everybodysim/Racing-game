import * as c from 'crashcat';import*as T from'three';
import{buildWallColliders,createSphereBody,setWallHeightBoost}from'../../js/Physics.js';
import{rebuildStaticSeams}from'../../js/StaticSeams.js?v=1';
import{CELL_RAW,GRID_SCALE}from'../../js/Track.js';
c.registerAll();const C=CELL_RAW*GRID_SCALE;const results=[];
function world(){const ws=c.createWorldSettings(),bm=c.addBroadphaseLayer(ws),bs=c.addBroadphaseLayer(ws),om=c.addObjectLayer(ws,bm),os=c.addObjectLayer(ws,bs);c.enableCollision(ws,om,os);c.enableCollision(ws,om,om);const w=c.createWorld(ws);w._OL_STATIC=os;w._OL_MOVING=om;return w;}
function slab(w,h,p,f=5){return c.rigidBody.create(w,{shape:c.box.create({halfExtents:h}),position:p,motionType:c.MotionType.STATIC,objectLayer:w._OL_STATIC,friction:f,restitution:0});}
function sim(w,start,vel,frames,force=true){const b=createSphereBody(w,start);c.rigidBody.setLinearVelocity(w,b,vel);let peak=-1e3,min=Infinity,max=-Infinity,samples=[];for(let i=0;i<frames;i++){if(force){const v=b.motionProperties.linearVelocity;c.rigidBody.setLinearVelocity(w,b,[vel[0],v[1],vel[2]]);c.rigidBody.setAngularVelocity(w,b,[vel[2]/.5,0,-vel[0]/.5]);}c.updateWorld(w,{},1/60);peak=Math.max(peak,b.motionProperties.linearVelocity[1]);min=Math.min(min,b.position[1]);max=Math.max(max,b.position[1]);if(i%10===0)samples.push([...b.position]);}return{b,peak,min,max,end:[...b.position],samples};}
for(const level of ['pool','tunnel'])for(const orient of[0,10,16,22])for(const uphill of[true,false]){
 const yaw=({0:0,10:180,16:90,22:270}[orient])*Math.PI/180,ux=Math.round(Math.sin(yaw)),uz=Math.round(Math.cos(yaw));
 const w=world();const holes=Array.from({length:4},(_,i)=>[ux*i,uz*i]);
 const extras=level==='pool'?{water:holes,poolSlopes:[[0,0,orient]]}:{tunnels:holes.map(([x,z],i)=>[x,z,0,orient,i===0?'slope-up':null])};buildWallColliders(w,null,[],extras);
 // Road slab starts at the high end (opposite the tunnel/pool direction).
 const gx=-ux,gz=-uz;slab(w,[C/2,.5,C/2],[(gx+.5)*C,-.615,(gz+.5)*C]);
 const floor=-.125-C*(level==='pool'?.34:.5)+.03;
 const start=uphill?[(.5+ux*1.3)*C,floor+.5,(.5+uz*1.3)*C]:[(.5-ux*.7)*C,.385,(.5-uz*.7)*C];
 const dir=uphill?-1:1;const r=sim(w,start,[ux*dir*4,0,uz*dir*4],210);
 if(r.peak>4||r.min<floor+.4)throw Error('pit slope '+level+' '+orient+' '+uphill+' '+JSON.stringify({...r,b:null}));
 if(uphill&&r.end[1]<.3)throw Error('cannot exit '+level+' '+orient+' '+JSON.stringify({...r,b:null}));
 if(!uphill&&r.end[1]>floor+.65)throw Error('cannot enter '+level+' '+orient+' '+JSON.stringify({...r,b:null}));
 results.push({case:level+'-slope',orient,uphill,peak:r.peak,end:r.end});
}
// A real wall must still stop a fast car. No global velocity restoration.
for(const speed of[25,100]){const w=world();slab(w,[30,.5,30],[0,-.5,0]);slab(w,[.2,3,10],[5,3,0],0);const r=sim(w,[0,.5,0],[speed,0,0],50);if(r.end[0]>4.35)throw Error('wall ghosting '+speed+' '+JSON.stringify({...r,b:null}));results.push({case:'real-wall',speed,end:r.end});}
// Removing an interior face must not extend the floor past a true cliff.
{const w=world();slab(w,[3,.5,3],[0,-.5,0]);const r=sim(w,[0,.5,0],[0,0,10],70);if(r.end[1]>-1)throw Error('cliff became infinite floor '+JSON.stringify({...r,b:null}));results.push({case:'real-cliff',end:r.end});}
// A real ramp must retain its launch. Box cube obstacles remain solid.
{const w=world();slab(w,[30,.5,30],[C*.5,-.615,C*.5]);buildWallColliders(w,null,[],{jumps:[[0,0,0]]});const r=sim(w,[C*.5,.385,C*.9],[0,0,-14],80);if(r.max<1||r.peak<2)throw Error('jump flattened');results.push({case:'real-jump',peak:r.peak,max:r.max});}
// Dynamic boxes must not be converted or altered by static seam repair.
{const w=world();slab(w,[30,.5,30],[0,-.5,0]);const box=c.rigidBody.create(w,{shape:c.box.create({halfExtents:[.5,.5,.5]}),position:[2,.5,0],motionType:c.MotionType.DYNAMIC,objectLayer:w._OL_MOVING,mass:100});const shape=box.shape;rebuildStaticSeams(w);if(box.shape!==shape)throw Error('dynamic box altered');const r=sim(w,[0,.5,0],[8,0,0],35);if(box.position[0]<=2.1)throw Error('dynamic box not pushed');results.push({case:'dynamic-box',position:[...box.position]});}
// Mega-wall height doubles exactly and can be restored after conversion.
{const w=world();buildWallColliders(w,null,[[0,0,'track-straight',0]],{});createSphereBody(w,[C*.5,.5,C*.5]);const before=w.bodies.pool.filter(b=>b.motionType===c.MotionType.STATIC).map(b=>({b,y:b.position[1],h:b.aabb[4]-b.aabb[1]}));setWallHeightBoost(true);for(const e of before)if(Math.abs((e.b.aabb[4]-e.b.aabb[1])-e.h*2)>1e-5)throw Error('mega height broken');setWallHeightBoost(false);for(const e of before)if(Math.abs(e.b.position[1]-e.y)>1e-5||Math.abs((e.b.aabb[4]-e.b.aabb[1])-e.h)>1e-5)throw Error('mega restore broken');results.push({case:'mega-walls',count:before.length});}
console.log(JSON.stringify(results,null,2));
