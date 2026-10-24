/* Заглушка вместо Claude API и Яндекса: /v1/messages (Claude), /v1/chat/completions и /ocr/v1/recognizeText (Яндекс) */
const http=require('http');
const log=[];
function answer(text){
  if(/На сколько градусов/.test(text))return '270';
  if(/Браслет|УТ-52/.test(text.split('Текст документа:').pop()))return JSON.stringify({docType:'счёт',docNo:'УТ-52',date:'2026-01-19',supplier:'ООО "БРАСЛЕТ-СЕРВИС"',total:36780,warnings:[],lines:[
    {rowNo:1,article:'106795',name:'Колонка-ночник Touch Light',unit:'шт',qty:36,price:740,sum:26640,role:'goods',addonTo:null,matchItemId:null,accountName:'Колонка-ночник',group:'Призы'},
    {rowNo:2,article:'17042W',name:'Полноцвет, УФ печать (ПОРТАТИВНАЯ КОЛОНКА)',unit:'шт',qty:36,price:70,sum:2520,role:'addon',addonTo:1,matchItemId:null,accountName:'',group:''},
    {rowNo:3,article:'102111',name:'Значки (закатные) 25мм',unit:'шт',qty:360,price:19,sum:6840,role:'goods',addonTo:null,matchItemId:null,accountName:'Значок закатной 25 мм',group:'Значки'},
    {rowNo:4,article:'000000D',name:'Доставка',unit:'шт',qty:1,price:780,sum:780,role:'delivery',addonTo:null,matchItemId:null,accountName:'',group:''}]});
  return '```json\n'+JSON.stringify({docType:'УПД',docNo:'ЦБ-2348',date:'2026-08-04',supplier:'ИП Абдул Самад Саммулах',total:21773,warnings:['В файле только 2 листа из 6'],lines:[
    {rowNo:1,article:'5050-745',name:'Бусины 10 мм*50 гр розовый №96',unit:'шт',qty:1,price:70,sum:70,role:'goods',addonTo:null,matchItemId:null,accountName:'Бусины 10 мм',group:'Бусины'},
    {rowNo:72,article:'807-21',name:'Фоамиран глиттерный',unit:'шт',qty:2,price:142,sum:284,role:'goods',addonTo:null,matchItemId:null,accountName:'Фоамиран глиттерный A4',group:'Бусины'}]})+'\n```';
}
http.createServer((req,res)=>{
  let b='';req.on('data',c=>b+=c);req.on('end',()=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/__log'){res.end(JSON.stringify(log));return}
    const j=JSON.parse(b||'{}');
    if(req.url==='/ocr/v1/recognizeText'){
      log.push({api:'ocr',model:j.model,mime:j.mimeType,bytes:Math.round((j.content||'').length*0.75),auth:req.headers.authorization,folder:req.headers['x-folder-id']});
      res.end(JSON.stringify({result:{textAnnotation:{width:'2263',height:'3200',rotate:'ANGLE_90',blocks:[],tables:[],fullText:'УПД № ЦБ-2348 от 04.08.2026',
        markdown:'Универсальный передаточный документ № ЦБ-2348 от 04.08.2026\n\n| № | Наименование | Кол-во | Сумма |\n|---|---|---|---|\n| 1 | Бусины 10 мм | 1 | 70,00 |'}}}));
      return;
    }
    if(req.url==='/v1/chat/completions'){
      const text=j.messages.map(m=>m.content).join('\n');
      log.push({api:'chat',model:j.model,nimg:0,len:text.length,max:j.max_tokens,auth:req.headers.authorization});
      res.end(JSON.stringify({id:'chatcmpl-mock',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:answer(text)},finish_reason:'stop'}]}));
      return;
    }
    const content=j.messages[0].content;
    const text=content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    const nimg=content.filter(c=>c.type==='image').length;
    log.push({api:'claude',model:j.model,nimg,len:text.length,max:j.max_tokens});
    res.end(JSON.stringify({content:[{type:'text',text:answer(text)}],stop_reason:'end_turn'}));
  });
}).listen(4010);
