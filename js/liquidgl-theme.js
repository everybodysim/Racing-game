(function(){
  function applyClasses(){
    const selectors=[
      '.panel','.card','.records-board','.record-chip','.modal','.hud-panel','.menu','.dialog',
      'button','.linkbtn','input','select','textarea','details','summary'
    ];
    const nodes=document.querySelectorAll(selectors.join(','));
    nodes.forEach((el)=>{
      if (el.closest('[data-liquid-ignore]')) return;
      el.classList.add('liquidGL');
      if (!el.querySelector(':scope > .content')) {
        const wrap=document.createElement('div');
        wrap.className='content';
        while (el.firstChild) wrap.appendChild(el.firstChild);
        el.appendChild(wrap);
      }
    });
  }

  function injectStyles(){
    const style=document.createElement('style');
    style.textContent=`
      .liquidGL{position:relative;overflow:hidden;backdrop-filter: blur(8px);background:rgba(255,255,255,0.08)!important;border:1px solid rgba(255,255,255,0.18)!important}
      .liquidGL>.content{position:relative;z-index:3}
    `;
    document.head.appendChild(style);
  }

  document.addEventListener('DOMContentLoaded',()=>{
    injectStyles();
    applyClasses();
    if (typeof window.liquidGL !== 'function') return;
    try{
      window.liquidGL({target:'.liquidGL',snapshot:'body',resolution:1.4,refraction:0.01,bevelDepth:0.052,bevelWidth:0.211,frost:1.2,shadow:true,specular:true,reveal:'fade',tilt:false,magnify:1});
    }catch(e){console.warn('liquidGL init failed',e)}
  });
})();
