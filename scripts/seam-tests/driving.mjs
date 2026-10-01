import * as c from'crashcat';import*as T from'three';import{Vehicle}from'../../js/Vehicle.js';import{buildWallColliders,createSphereBody}from'../../js/Physics.js';import{CELL_RAW,GRID_SCALE}from'../../js/Track.js';c.registerAll();const C=CELL_RAW*GRID_SCALE;
function world(){const ws=c.createWorldSettings(),bm=c.addBroadphaseLayer(ws),bs=c.addBroadphaseLayer(ws),om=c.addObjectLayer(ws,bm),os=c.addObjectLayer(ws,bs);c.enableCollision(ws,om,os);const w=c.createWorld(ws);w._OL_STATIC=os;w._OL_MOVING=om;return w;}
function floor(w){c.rigidBody.create(w,{shape:c.box.create({halfExtents:[40,.5,40]}),motionType:c.MotionType.STATIC,objectLayer:w._OL_STATIC,position:[0,-.615,0],friction:5});}
const results=[];
for(const orient of[0,10,16,22]){
 const yaw=({0:0,10:180,16:90,22:270}[orient])*Math.PI/180,ux=-Math.round(Math.sin(yaw)),uz=-Math.round(Math.cos(yaw));const w=world();buildWallColliders(w,null,[],{elevated:[[0,0,'slope-up',orient],...Array.from({length:10},(_,i)=>[ux*(i+1),uz*(i+1),'elevated-straight',orient])]});floor(w);
 const v=new Vehicle();v.rigidBody=createSphereBody(w,[(.5-ux*.8)*C,.385,(.5-uz*.8)*C]);v.physicsWorld=w;v.setSpawn(v.rigidBody.position.slice(),yaw+Math.PI);v.resetToSpawn();let peak=0,min=.385;
 for(let i=0;i<420;i++){v.update(1/60,{x:0,z:1});c.updateWorld(w,{},1/60);peak=Math.max(peak,v.rigidBody.motionProperties.linearVelocity[1]);min=Math.min(min,v.rigidBody.position[1]);}
 if(v.rigidBody.position[1]<4||peak>10||min<.3)throw Error('actual controls failed slope '+orient+' '+JSON.stringify(v.rigidBody.position));results.push({orient,end:[...v.rigidBody.position],peak});
}
// A thousand touching floor tiles: conversion time and stable driving.
{const w=world();for(let x=0;x<20;x++)for(let z=0;z<50;z++)c.rigidBody.create(w,{shape:c.box.create({halfExtents:[C*.5,.09,C*.5]}),position:[(x+.5)*C,-.09,(z+.5)*C],motionType:c.MotionType.STATIC,objectLayer:w._OL_STATIC,friction:1});const t=performance.now();createSphereBody(w,[C*.5,.5,C*.5]);results.push({case:'1000 tiles',initMs:performance.now()-t});}
console.log(JSON.stringify(results,null,2));
