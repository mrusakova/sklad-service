const { chromium } = require('playwright');
const fs=require('fs');
const U=(process.env.DOCS_DIR||'.')+'/';
const inv=fs.readdirSync(U).find(f=>f.startsWith('7a5fab74'));
const upd=fs.readdirSync(U).find(f=>f.startsWith('c23d81c8'));
const out=[];const ok=(c,m)=>{out.push((c?'PASS ':'FAIL ')+m)};
(async()=>{
  const b=await chromium.launch({...(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{}),args:['--no-sandbox']});
  const ctx=await b.newContext({viewport:{width:1280,height:900}});
  const p=await ctx.newPage();
  const errs=[];p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});p.on('pageerror',e=>errs.push('PAGEERR '+e.message));
  await p.goto('http://localhost:3100/');
  ok(p.url().includes('login.html'),'redirect to login');
  await p.fill('#login','admin');await p.fill('#pw','wrong');await p.click('#go');
  await p.waitForSelector('#err:not([hidden])');ok(true,'wrong password shows error');
  await p.fill('#pw','testtest123');await p.click('#go');
  await p.waitForURL('http://localhost:3100/');
  await p.waitForSelector('#tabs button');
  const tabs=await p.$$eval('#tabs button',els=>els.map(e=>e.textContent.trim()));
  ok(tabs.length===7,'admin sees 7 tabs: '+tabs.join('|'));
  // projects
  await p.click('[data-tab=refs]');
  for(const n of ['Лига Х','Турнир Нордена']){await p.fill('#pName',n);await p.click('#pAdd');await p.waitForTimeout(500)}
  ok((await p.textContent('#tab-refs')).includes('Турнир Нордена'),'projects added');
  // income: invoice pdf
  await p.click('[data-tab=income]');
  await p.setInputFiles('#file',U+inv);
  await p.click('#btnParse');
  await p.waitForSelector('#dTbl tbody tr',{timeout:30000});
  const status=await p.textContent('#parseStatus');
  const units=await p.$$eval('#dTbl tbody tr [data-c=unit]',els=>els.map(e=>e.textContent.replace(/\s/g,' ').trim()));
  console.log('units',units,'status',status);
  ok(units[0].startsWith('827,55'),'speaker unit cost 827,55');
  ok(units[2].startsWith('19,41'),'badge unit cost 19,41');
  const groups=await p.$$eval('#dTbl [data-f=group]',els=>els.map(e=>e.value));
  ok(groups.join()==='Призы,Значки','groups prefilled '+groups);
  const sum=await p.textContent('#dSummary');ok(sum.includes('36 780,00')||sum.includes('36 780,00'),'summary shows total');
  await p.screenshot({path:'shot-draft.png',fullPage:true});
  await p.click('#saveRecv');
  await p.waitForFunction(()=>document.querySelector('#parseStatus')&&/Оприходовано/.test(document.querySelector('#parseStatus').textContent),{timeout:15000});
  ok(true,'received');
  await p.click('[data-tab=stock]');await p.waitForSelector('#stockTbl table');
  const stock=await p.textContent('#stockTbl');ok(stock.includes('Колонка-ночник')&&stock.includes('Значок закатной 25 мм'),'stock lists items');
  await p.screenshot({path:'shot-stock.png',fullPage:true});
  // write-off
  await p.click('[data-tab=writeoff]');
  await p.selectOption('#woProj',{label:'Лига Х'});
  await p.waitForSelector('select[data-f=itemId]');
  const opt=await p.$$eval('select[data-f=itemId] option',o=>o.map(x=>({v:x.value,t:x.textContent})));
  const col=opt.find(o=>/Колонка/.test(o.t));await p.selectOption('select[data-f=itemId]',col.v);
  await p.fill('input[data-f=qty]','40');await p.click('#woSave');
  ok((await p.textContent('#woMsg')).includes('только 36'),'overdraw blocked');
  await p.fill('input[data-f=qty]','10');await p.click('#woSave');
  await p.waitForFunction(()=>/Списано на проект/.test(document.querySelector('#woMsg').textContent),{timeout:10000});ok(true,'write-off done');
  await p.click('[data-tab=stock]');await p.waitForTimeout(800);
  const st2=await p.textContent('#stockTbl');ok(/Колонка-ночник[\s\S]*?26/.test(st2),'stock after write-off shows 26');
  // inline rename
  await p.click('[data-edit]');await p.fill('[data-en]','Колонка-ночник Touch');await p.click('[data-save]');await p.waitForTimeout(800);
  ok((await p.textContent('#stockTbl')).includes('Колонка-ночник Touch'),'rename works');
  // inventory
  await p.click('[data-tab=inventory]');await p.click('#invFill');
  await p.fill('tr[data-id] input[data-fact] >> nth=0','20');
  await p.waitForTimeout(300);
  const invSum=await p.textContent('#invSum');ok(/Расхождений: 1/.test(invSum),'inventory sees 1 discrepancy: '+invSum);
  await p.click('#invSave');await p.click('#invSave');
  await p.waitForFunction(()=>/Инвентаризация проведена/.test(document.querySelector('#invMsg').textContent),{timeout:10000});ok(true,'inventory saved');
  await p.click('[data-tab=journal]');await p.waitForTimeout(500);
  const jr=await p.textContent('#tab-journal');ok(jr.includes('инвентаризация')&&jr.includes('Недостача по инвентаризации'),'journal shows inventory');
  await p.screenshot({path:'shot-journal.png',fullPage:true});
  // scanned UPD
  await p.click('[data-tab=income]');
  await p.setInputFiles('#file',U+upd);
  await p.click('#btnParse');
  await p.waitForSelector('#dTbl tbody tr',{timeout:90000});
  const warn=await p.textContent('#dSummary');ok(/В файле только 2 листа/.test(warn),'UPD warnings shown');
  await p.screenshot({path:'shot-upd.png',fullPage:true});
  const log=await (await fetch('http://localhost:4010/__log')).json();
  console.log('mock log',JSON.stringify(log));
  if(process.env.PROVIDER==='yandex'){
    const ocr=log.filter(l=>l.api==='ocr');ok(ocr.length===2&&ocr.every(l=>l.mime==='JPEG'&&l.model&&l.folder),'UPD pages sent to OCR: '+ocr.length);
    ok(!log.some(l=>l.max===30),'no separate rotation call');
    const chat=log.filter(l=>l.api==='chat').pop();ok(chat&&/^gpt:\/\//.test(chat.model)&&/^Api-Key /.test(chat.auth),'UPD text parsed by LLM: '+(chat&&chat.model));
  }else{
    ok(log.some(l=>l.max===30),'rotation detect call made');
    const big=log.filter(l=>l.max>100).pop();ok(big&&big.nimg>=2,'UPD sent as images: '+(big&&big.nimg));
  }
  await p.click('#dropDraft');await p.click('#dropDraft');
  // users tab
  await p.click('[data-tab=users]');await p.waitForSelector('#nuAdd');
  await p.fill('#nuLogin','petya');await p.fill('#nuPw','petyapass1');await p.selectOption('#nuRole','viewer');await p.click('#nuAdd');
  await p.waitForFunction(()=>/Пользователь создан/.test(document.querySelector('#uMsg')?.textContent||''),{timeout:5000});ok(true,'user created via UI');
  // viewer
  const ctx2=await b.newContext();const v=await ctx2.newPage();
  await v.goto('http://localhost:3100/login.html');await v.fill('#login','petya');await v.fill('#pw','petyapass1');await v.click('#go');
  await v.waitForSelector('#tabs button');
  const vt=await v.$$eval('#tabs button',els=>els.map(e=>e.textContent.trim()));ok(vt.join()==='Остатки,Журнал и проекты','viewer tabs: '+vt);
  ok(!(await v.$('[data-edit]')),'viewer has no edit buttons');
  console.log('console errors:',errs);
  console.log(out.join('\n'));
  await b.close();
})().catch(e=>{console.log(out.join('\n'));console.log('ERR',e.message);process.exit(1)});
