import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const page = await b.newPage({ viewport:{width:932,height:430} });
await page.goto('http://127.0.0.1:5173/?scene=island',{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.islandScene?.ready===true,null,{timeout:200000});
await page.waitForFunction(()=>!document.querySelector('.tm-loading-root'),null,{timeout:200000});
const read = () => page.evaluate(()=>{
  const s = window.islandScene, MM = 5;
  const q = s.queen;
  const plan = q.legPlan();
  const soleY = Math.min(...plan.map(l=>l.home[1]));
  const scale = s.drive ? s.drive.scale : 1;
  return {
    caste: q.rig.caste,
    scale,
    bodyTopAboveSole_wu: q.bodyTopAboveSole(),
    bodyTopAboveSole_mm: q.bodyTopAboveSole()*MM,
    standingHeight_mm: q.standingHeight()*MM,
    bodyRadius_mm: q.bodyRadius()*MM,
    soleY_wu: soleY,
    reachUp_now_wu: (2.5*scale)/MM,
    reachUp_now_mm: 2.5*scale,
  };
});
console.log('QUEEN ', JSON.stringify(await read()));
await page.evaluate(async ()=>{ await window.islandScene.becomeWorker(); });
await page.waitForTimeout(2500);
console.log('WORKER', JSON.stringify(await read()));
await b.close();
