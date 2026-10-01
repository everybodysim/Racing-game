export async function resolve(specifier,context,nextResolve){
 if(specifier==='three')return{url:new URL('./node_modules/three/build/three.module.js',import.meta.url).href,shortCircuit:true};
 if(specifier==='crashcat')return{url:new URL('./node_modules/crashcat/dist/index.js',import.meta.url).href,shortCircuit:true};
 return nextResolve(specifier,context);
}
