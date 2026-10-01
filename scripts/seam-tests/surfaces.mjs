import * as cc from 'crashcat';
import * as THREE from 'three';
import {buildWallColliders,createSphereBody,setWallHeightBoost} from '../../js/Physics.js';
import {rebuildStaticSeams} from '../../js/StaticSeams.js?v=1';
import {CELL_RAW,GRID_SCALE} from '../../js/Track.js';
cc.registerAll();const C=CELL_RAW*GRID_SCALE;
function world(){const ws=cc.createWorldSettings();ws.gravity=[0,-9.81,0];const bp=cc.addBroadphaseLayer(ws),bs=cc.addBroadphaseLayer(ws);const om=cc.addObjectLayer(ws,bp),os=cc.addObjectLayer(ws,bs);cc.enableCollision(ws,om,os);cc.enableCollision(ws,om,om);const w=cc.createWorld(ws);w._OL_MOVING=om;w._OL_STATIC=os;return w;}
function floor(w,h,p){cc.rigidBody.create(w,{shape:cc.box.create({halfExtents:h}),position:p,motionType:cc.MotionType.STATIC,objectLayer:w._OL_STATIC,friction:5,restitution:0});}
function probe(w,p){const settings=cc.createDefaultCastRaySettings(),filter=cc.filter.forWorld(w);filter.bodyFilter=b=>b.motionType===cc.MotionType.STATIC;const collector=cc.createClosestCastRayCollector();cc.castRay(w,collector,settings,p,[0,-1,0],30,filter);return collector.hit.status===cc.CastRayStatus.COLLIDING?p[1]-collector.hit.fraction*30:null;}
function drive(w,start,v,steps=180){const b=createSphereBody(w,start);b.motionProperties.allowSleeping=false;let peakVy=-Infinity,minY=Infinity,maxY=-Infinity;for(let i=0;i<steps;i++){const prior=b.motionProperties.linearVelocity;cc.rigidBody.setLinearVelocity(w,b,[v[0],prior[1],v[1]]);cc.rigidBody.setAngularVelocity(w,b,[v[1]/.5,0,-v[0]/.5]);cc.updateWorld(w,{},1/60);peakVy=Math.max(peakVy,prior[1]);minY=Math.min(minY,b.position[1]);maxY=Math.max(maxY,b.position[1]);}const result={peakVy,minY,maxY,end:b.position.slice(),vel:b.motionProperties.linearVelocity.slice()};cc.rigidBody.remove(w,b);return result;}
const out=[];
for(const frictionCase of ['tunnel','pool','elevated'])for(const speed of [10,25,50,100]){
 const w=world();const cells=Array.from({length:36},(_,i)=>[0,i]);let top;
 if(frictionCase==='elevated'){buildWallColliders(w,null,[],{elevated:cells.map(([x,z])=>[x,z,'elevated-straight',0])});top=-.125+C*.5-.06+.09;}
 else if(frictionCase==='tunnel'){buildWallColliders(w,null,[],{tunnels:cells.map(([x,z])=>[x,z,0,0,null])});top=-.125-C*.5+.03;}
 else {buildWallColliders(w,null,[],{water:cells});top=-.125-C*.34+.03;}
 const r=drive(w,[C*.5,top+.5,C*.5],[0,speed],100);
 if(r.peakVy>.1||r.maxY>top+.53||r.minY<top+.45)throw Error('flat seam failed '+frictionCase+' '+JSON.stringify(r));
 out.push({case:frictionCase,speed,...r});
}
for(const orient of [0,10,16,22]){
 const yaw=THREE.MathUtils.degToRad({0:0,10:180,16:90,22:270}[orient]);const ux=-Math.round(Math.sin(yaw)),uz=-Math.round(Math.cos(yaw));
 const w=world();buildWallColliders(w,null,[],{elevated:[[0,0,'slope-up',orient],[ux,uz,'elevated-straight',orient],[ux*2,uz*2,'elevated-straight',orient]]});floor(w,[30,.5,30],[C*.5,-.615,C*.5]);
 rebuildStaticSeams(w);
 const topLow=probe(w,[C*.5-ux*C*.5,8,C*.5-uz*C*.5]);const topHigh=probe(w,[C*.5+ux*C*.5,8,C*.5+uz*C*.5]);
 if(Math.abs(topHigh-(-.125+C*.5+.03))>.003)throw Error('ramp high seam gap: '+topHigh);
 const start=[C*.5-ux*C*.7,.385,C*.5-uz*C*.7];const r=drive(w,start,[ux*7,uz*7],130);
 if(r.end[1]<3.7||r.peakVy>7)throw Error('uphill failed '+orient+' '+JSON.stringify(r));
 out.push({case:'uphill',orient,topLow,topHigh,...r});
 const down=drive(w,[C*.5+ux*C*1.8,4.15125,C*.5+uz*C*1.8],[-ux*6,-uz*6],200);
 if(down.end[1]>.7||down.minY<.25||down.peakVy>3)throw Error('downhill failed '+orient+' '+JSON.stringify(down));
 out.push({case:'downhill',orient,...down});
}
console.log(JSON.stringify(out,null,2));
