import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const page = await b.newPage({ viewport:{width:932,height:430} });
await page.goto('http://127.0.0.1:5173/?scene=island',{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.islandScene?.ready===true,null,{timeout:200000});
await page.waitForFunction(()=>!document.querySelector('.tm-loading-root'),null,{timeout:200000});
console.log(JSON.stringify(await page.evaluate(async ()=>{
  const s = window.islandScene, MM = 5;
  // dig a steep hole, the way the founding does
  s.aimPitchForTest(-55 * Math.PI/180);
  if (!s.digMode) s.toggleDig();
  s.input.dig = true;
  s.stepForTest(1/60, 900);
  s.input.dig = false;
  s.stepForTest(1/60, 60);

  const d = s.drive;
  const up = s.up.clone();
  const at = s.at.clone();
  const legs = d.legsForTest ? d.legsForTest() : d.legs;
  const rows = legs.map(l => {
    const rel = l.at.clone().sub(at);
    return { slot: l.slot, planted: !!l.planted, groping: !!l.groping,
             aboveBody_mm: +(rel.dot(up)*MM).toFixed(2) };
  });
  return {
    reachUp_mm: +(d.reachUpWu*MM).toFixed(3),
    bodyTop_mm: +(s.queen.bodyTopAboveSole()*MM).toFixed(3),
    underground: s.statsForTest().underground,
    legs: rows,
    groping: rows.filter(r=>r.groping).length,
    highest_mm: Math.max(...rows.map(r=>r.aboveBody_mm)),
  };
}), null, 1));
await b.close();
