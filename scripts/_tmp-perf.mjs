/* How long does one simulated step cost, at N worms? Measured as the cost of
 * the worm tick itself rather than wall-clock frame rate, because SwiftShader
 * renders far slower than a phone and would drown the signal. */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport:{width:932,height:430} });
await p.goto('http://127.0.0.1:5173/?scene=island',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.islandScene?.ready===true,null,{timeout:200000});
await p.waitForFunction(()=>!document.querySelector('.tm-loading-root'),null,{timeout:200000});
await p.waitForFunction(()=>window.islandScene.wormBodiesForTest().length>0,null,{timeout:60000}).catch(()=>{});
await p.waitForTimeout(800);
const out = await p.evaluate(()=>{
  const s = window.islandScene;
  const base = s.wormsForTest().length;
  const time = (n) => {
    /* Clone the population up to n by re-seeding from the ones we have. */
    const t0 = performance.now();
    for (let i=0;i<600;i+=1) s.stepForTest(1/60,1);
    return (performance.now()-t0)/600;
  };
  const a = time();
  return { worms: base, msPerStep: +a.toFixed(3), bodies: s.wormBodiesForTest().length };
});
console.log(JSON.stringify(out));
await b.close();
