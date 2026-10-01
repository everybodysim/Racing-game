import * as c from'crashcat';import*as T from'three';import{createSphereBody}from'../../js/Physics.js';c.registerAll();const results=[];
function world(){const ws=c.createWorldSettings(),bm=c.addBroadphaseLayer(ws),bs=c.addBroadphaseLayer(ws),om=c.addObjectLayer(ws,bm),os=c.addObjectLayer(ws,bs);c.enableCollision(ws,om,os);const w=c.createWorld(ws);w._OL_STATIC=os;w._OL_MOVING=om;return w;}
function box(w,h,p,q=[0,0,0,1],friction=0){c.rigidBody.create(w,{shape:c.box.create({halfExtents:h}),position:p,quaternion:q,motionType:c.MotionType.STATIC,objectLayer:w._OL_STATIC,friction,restitution:0});}
for(const yaw of[0,.4,Math.PI/2])for(const speed of[10,50,100]){
 const w=world(),q=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),yaw).toArray();box(w,[300,.5,300],[0,-.5,0],undefined,5);
 for(let i=0;i<40;i++){const p=new T.Vector3(5,3,i*8).applyAxisAngle(new T.Vector3(0,1,0),yaw);box(w,[.2,3,4],p.toArray(),q);}
 const start=new T.Vector3(4.32,.5,0).applyAxisAngle(new T.Vector3(0,1,0),yaw);const b=createSphereBody(w,start.toArray());const forward=new T.Vector3(0,0,speed).applyAxisAngle(new T.Vector3(0,1,0),yaw),into=new T.Vector3(.6,0,0).applyAxisAngle(new T.Vector3(0,1,0),yaw);let maxUp=0,minAlong=speed;
 for(let i=0;i<120;i++){const vel=b.motionProperties.linearVelocity;const v=forward.clone().add(into);c.rigidBody.setLinearVelocity(w,b,[v.x,vel[1],v.z]);c.rigidBody.setAngularVelocity(w,b,[v.z/.5,0,-v.x/.5]);c.updateWorld(w,{},1/60);maxUp=Math.max(maxUp,vel[1]);minAlong=Math.min(minAlong,new T.Vector3(...vel).dot(forward.clone().normalize()));}
 if(maxUp>.1||minAlong<speed*.95)throw Error('wall seam snag '+JSON.stringify({yaw,speed,maxUp,minAlong}));results.push({yaw,speed,maxUp,minAlong});
}
console.log(JSON.stringify(results,null,2));
