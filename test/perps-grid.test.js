'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { PerpsGridBot, STRATEGY } = require('../perps-grid-bot');
const { PerpsPaperStore } = require('../perps-paper-store');
const { executePending, normalizeBook } = require('../perps-grid-execution');
const startServer = require('../server');
const { startApplication } = require('../index');
const vm = require('node:vm');
const START = 1800000000000;
function near(a,b,t=.01){assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);}
function fixture() {
  let now=START+10000;
  const prices={6:100,7:200},depth={6:1000,7:1000};
  const options={rate:0,funding:0,stale:false,bookAge:0};
  const calls=[];
  const api={
    async instruments(){calls.push('instruments');return [6,7].map(id=>({
      instrument_id:id,symbol:id===6?'BTC-USD':'ETH-USD',quantity_decimals:id===6?5:4,
      category:'crypto',max_leverage:50,min_notional:'10',liquidation_fee:'0.01',risk_tiers:[{lower_bound:'0',max_leverage:50}],
    }));},
    async fees(){calls.push('fees');return{fee_schedule:[{instrument_type:'perpetual',category:'crypto',
      tiers:[{min_volume_30d:0,taker_fee_rate:options.rate,maker_fee_rate:options.rate}]}]};},
    async tickers(){calls.push('tickers');return[6,7].map(id=>({instrument_id:id,mark_price:String(prices[id]),
      timestamp:now-(options.stale?20000:0),funding_rate:String(options.funding),
      next_funding:Math.floor(now/3600000)*3600000+3600000}));},
    async book(id){calls.push('book');return{instrument_id:id,timestamp:now-options.bookAge,
      bids:[[String(prices[id]-.01),String(depth[id])]],asks:[[String(prices[id]+.01),String(depth[id])]]};},
  };
  const bot=new PerpsGridBot({api,clock:()=>now});
  return{bot,api,prices,depth,options,calls,get now(){return now;},advance(ms=1000){now+=ms;},
    async cycle(){now+=1000;await bot.tick();},
    async open(){await bot.initialize();await bot.tick();now+=1000;await bot.tick();return bot.state.legs;}};
}
test('opens only BTC long and ETH short using $5,000, 30/20 margin units and exactly 5×',async()=>{
  const f=fixture(),[btc,eth]=await f.open(),a=f.bot.account();
  assert.equal(STRATEGY.leverage,5);assert.equal(a.startingCapital,5000);
  assert.equal(btc.direction,'LONG');assert.equal(eth.direction,'SHORT');
  near(btc.quantity*btc.entryPrice,7500,.002);near(eth.quantity*eth.entryPrice,5000,.03);
  near(a.initialMargin,2500,.3);assert.ok(a.freeMargin>2498);
  assert.ok(btc.initialized&&eth.initialized);assert.ok(btc.originalEntry>100&&eth.originalEntry<200);
  assert.deepEqual([...new Set(f.calls)].sort(),['book','fees','instruments','tickers']);
  assert.equal(f.bot.snapshot().source,undefined);
});
test('open and adjustment orders wait at least 500ms and require later non-stale books',async()=>{
  const f=fixture();await f.bot.initialize();await f.bot.tick();
  assert.equal(f.bot.state.trades.length,0);await f.bot.tick();assert.equal(f.bot.state.trades.length,0);
  f.advance(1000);f.options.bookAge=20000;await f.bot.tick();
  assert.equal(f.bot.state.trades.length,0);assert.equal(f.bot.state.status,'waiting');
  f.options.bookAge=0;await f.bot.tick();assert.ok(f.bot.state.trades.length>=2);
});
test('BTC favourable 0.5% reduces two current-equity units using actual later bids',async()=>{
  const f=fixture(),[btc]=await f.open(),original=btc.originalEntry,before=btc.quantity;
  f.prices[6]=original*1.005;await f.cycle();
  const p=structuredClone(btc.pending);
  assert.equal(p.kind,'REDUCE');assert.equal(p.level,1);near(p.unitValue,f.bot.account().equity/100);
  f.prices[6]=original*1.006;await f.cycle();
  const trade=f.bot.state.trades[0];
  assert.equal(trade.action,'REDUCE');assert.equal(trade.side,'SELL');assert.ok(btc.quantity<before);
  near(trade.price,f.prices[6]-.01);assert.notEqual(trade.price,p.triggerPrice);
  near(trade.quantity,p.quantityRemaining,.00002);assert.equal(btc.levels['1'].status,'DONE');
});
test('ETH falling is favourable and rising is adverse; adds are sells and reductions are buys',async()=>{
  const f=fixture(),[,eth]=await f.open(),anchor=eth.originalEntry;
  f.prices[7]=anchor*.995;await f.cycle();assert.equal(eth.pending.kind,'REDUCE');
  await f.cycle();assert.equal(f.bot.state.trades[0].side,'BUY');
  f.prices[7]=anchor*1.005;await f.cycle();assert.equal(eth.pending.kind,'ADD');
  await f.cycle();assert.equal(f.bot.state.trades[0].side,'SELL');
  assert.equal(eth.originalEntry,anchor);assert.notEqual(eth.entryPrice,anchor);
});
test('original anchor never changes; each level fires once despite staying or recrossing',async()=>{
  const f=fixture(),[btc]=await f.open(),anchor=btc.originalEntry;
  f.prices[6]=anchor*.995;await f.cycle();await f.cycle();
  const count=f.bot.state.trades.length,qty=btc.quantity;
  for(const price of [anchor*.995,anchor,anchor*.995,anchor*.995]){f.prices[6]=price;await f.cycle();}
  assert.equal(f.bot.state.trades.length,count);near(btc.quantity,qty,.000001);
  assert.equal(btc.originalEntry,anchor);assert.equal(btc.levels['-1'].status,'DONE');
});
test('a jump across several levels processes each once at current books, not old grid prices',async()=>{
  const f=fixture(),[btc]=await f.open(),anchor=btc.originalEntry;
  f.prices[6]=anchor*1.017;
  for(let i=0;i<5;i++)await f.cycle();
  assert.deepEqual(Object.keys(btc.levels),['1','2','3']);
  assert.ok(Object.values(btc.levels).every(x=>x.status==='DONE'));
  assert.ok(f.bot.state.trades.filter(t=>t.action==='REDUCE').every(t=>t.price>anchor*1.015));
});
test('insufficient margin skips additions without consuming their levels; free margin permits retry',async()=>{
  const f=fixture(),[btc]=await f.open();
  f.prices[6]=btc.originalEntry*.995;await f.bot.api.tickers().then(x=>f.bot.updateTickers(x));
  const a=f.bot.account();f.bot.state.account.cash-=a.freeMargin-20;
  f.bot.consider(btc);assert.equal(btc.pending,null);assert.equal(btc.levels['-1'],undefined);
  assert.match(btc.decision,/insufficient margin/);
  f.bot.state.account.cash+=300;f.bot.consider(btc);
  assert.equal(btc.pending.kind,'ADD');assert.equal(btc.pending.level,-1);
});
test('a fully reduced side stays permanently closed and cannot reopen or flip',async()=>{
  const f=fixture(),[btc]=await f.open();
  f.bot.state.account.cash=1000000;f.prices[6]=btc.originalEntry*1.005;
  await f.cycle();await f.cycle();
  assert.equal(btc.quantity,0);assert.equal(btc.closedPermanently,true);
  const count=f.bot.state.trades.length;f.prices[6]=btc.originalEntry*.9;
  await f.cycle();await f.cycle();
  assert.equal(btc.pending,null);assert.equal(f.bot.state.trades.filter(t=>t.symbol==='BTC').length,2);
  assert.ok(f.bot.state.trades.length>=count);
});
test('fees reduce equity and dynamic unit sizing, without deducting leveraged notional from cash',async()=>{
  const f=fixture();f.options.rate=.0005;await f.open();
  const a=f.bot.account();near(a.fees,6.25,.001);near(a.cash,4993.75,.001);
  near(a.unitValue,a.equity/100,.000001);assert.ok(a.unitValue<50);
  near(a.cash,5000-a.fees);assert.ok(a.openNotional>12490);
});
test('stale or missing marks pause all trading and create unknown equity rather than fake zero',async()=>{
  const f=fixture();await f.open();f.options.stale=true;f.advance(20000);await f.bot.tick();
  const s=f.bot.snapshot();assert.equal(s.account.equity,null);assert.equal(s.account.unitValue,null);
  assert.deepEqual(s.account.unpricedSymbols,['BTC','ETH']);assert.equal(s.legs[0].mark,null);
  assert.equal(s.status,'waiting');assert.equal(s.equityCurve.at(-1).equity,null);
});
test('partial execution consumes depth only once until visible replenishment',async()=>{
  const f=fixture();f.depth[6]=1;await f.bot.initialize();await f.bot.tick();await f.cycle();
  const btc=f.bot.state.legs[0];near(btc.quantity,1);assert.ok(btc.pending);
  await f.cycle();near(btc.quantity,1);
  f.depth[6]=2;await f.cycle();near(btc.quantity,2);
  assert.equal(btc.originalEntry,null);assert.equal(btc.initialized,false);
});
test('hourly funding is direction-aware, separately accounted and not charged twice',async()=>{
  const f=fixture();f.options.funding=.001;await f.open();
  const [btc,eth]=f.bot.state.legs,expected=-btc.quantity*f.prices[6]*.001+eth.quantity*f.prices[7]*.001;
  f.advance(3600000);await f.bot.tick();near(f.bot.state.account.fundingPnl,expected,.0001);
  await f.cycle();near(f.bot.state.account.fundingPnl,expected,.0001);
});
test('maintenance breach cancels strategy entries and unwinds only through depth-backed liquidation',async()=>{
  const f=fixture();await f.open();f.prices[6]=1;await f.cycle();
  assert.equal(f.bot.state.halted,true);assert.ok(f.bot.state.legs.every(l=>l.pending?.kind==='LIQUIDATE'));
  await f.cycle();assert.ok(f.bot.state.legs.every(l=>l.quantity===0&&l.closedPermanently));
  assert.equal(f.bot.state.status,'risk_halt');assert.ok(f.bot.state.trades.some(t=>t.action==='LIQUIDATE'&&t.fee>0));
});
test('freshness, instrument identity, bad depth and crossed books fail explicitly',()=>{
  const valid={instrument_id:6,timestamp:START,bids:[['99','1']],asks:[['100','1']]};
  assert.equal(normalizeBook(valid,6,START).asks[0].price,100);
  for(const patch of [{instrument_id:7},{timestamp:START+1},{timestamp:START-16000},
    {asks:[['100','NaN']]},{asks:[['100','1'],['100','2']]},{asks:[['98','1']]}])
    assert.throws(()=>normalizeBook({...valid,...patch},6,START));
});
test('restarts preserve cash, used levels, original anchors and pending remainder without re-entry',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'perps-grid-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new PerpsPaperStore(path.join(dir,'state.json')),f=fixture();f.bot.store=store;
  await f.open();const btc=f.bot.state.legs[0];
  f.prices[6]=btc.originalEntry*.995;await f.cycle();await f.cycle();
  f.prices[6]=btc.originalEntry*.99;await f.cycle();assert.equal(btc.pending.level,-2);
  const restored=new PerpsGridBot({api:f.api,store,clock:()=>f.now});
  await restored.initialize();assert.equal(restored.state.legs[0].pending.level,-2);
  assert.equal(restored.state.legs[0].originalEntry,btc.originalEntry);
  assert.equal(restored.state.legs[0].levels['-1'].status,'DONE');
  near(restored.account().cash,f.bot.account().cash,.000001);
  f.advance();await restored.tick();assert.equal(restored.state.legs[0].levels['-2'].status,'DONE');
  assert.equal(restored.state.trades.filter(x=>x.action==='OPEN').length,2);
  const bad=structuredClone(restored.state);bad.account.cash+=1;
  assert.throws(()=>restored.validate(bad),/reconciliation/);
});
test('persistence failure blocks further trading until the ledger can be saved',async()=>{
  const f=fixture();await f.open();let failing=true;
  f.bot.store={save:async()=>{if(failing)throw Error('disk unavailable');}};
  await f.cycle();assert.equal(f.bot.state.status,'persistence_error');
  const count=f.bot.state.trades.length;f.prices[6]=f.bot.state.legs[0].originalEntry*.995;
  await f.cycle();assert.equal(f.bot.state.trades.length,count);assert.equal(f.bot.state.legs[0].pending,null);
  failing=false;await f.cycle();assert.equal(f.bot.state.legs[0].pending.kind,'ADD');
});
test('HTTP state and dashboard expose the independent paper strategy and no wallet copying',async t=>{
  const f=fixture();await f.open();const server=startServer(f.bot,0);
  await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const url='http://127.0.0.1:'+server.address().port;
  const s=await(await fetch(url+'/api/state')).json();
  assert.equal(s.strategy.id,STRATEGY.id);assert.equal(s.source,undefined);assert.equal(s.legs.length,2);
  const html=await(await fetch(url+'/')).text();
  assert.match(html,/BTC/);assert.match(html,/ETH/);assert.doesNotMatch(html,/api\/.*reset/);
  assert.equal((await fetch(url+'/api/healthz')).status,200);
});
test('production startup resets into a separate $5,000 ledger without reading or deleting copy history',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'grid-startup-')),old=path.join(dir,'old-copy.json');
  await fs.writeFile(old,'previous copy history remains unchanged');
  const signals={SIGTERM:process.listeners('SIGTERM'),SIGINT:process.listeners('SIGINT')};
  const f=fixture(),app=await startApplication({env:{PERPS_COPY_LEDGER_PATH:old,RAILWAY_ENVIRONMENT_ID:'test'},api:f.api,port:0});
  t.after(async()=>{
    await app.bot.stopAndFlush();await new Promise(r=>app.server.close(r));
    for(const sig of ['SIGTERM','SIGINT'])for(const fn of process.listeners(sig))if(!signals[sig].includes(fn))process.removeListener(sig,fn);
    await fs.rm(dir,{recursive:true,force:true});
  });
  if(!app.server.listening)await new Promise(r=>app.server.once('listening',r));
  const state=await(await fetch('http://127.0.0.1:'+app.server.address().port+'/api/state')).json();
  assert.equal(state.account.startingCapital,5000);assert.equal(state.source,undefined);assert.equal(state.trades.length,0);
  assert.equal(await fs.readFile(old,'utf8'),'previous copy history remains unchanged');
  const saved=JSON.parse(await fs.readFile(path.join(dir,'independent-btc-eth-grid-v1.json'),'utf8'));
  assert.equal(saved.state.strategyId,STRATEGY.id);
  await assert.rejects(()=>startApplication({env:{LIVE_TRADING:'true'},listen:false}),/paper-only/);
});
test('dashboard renders actual capital units, null equity, trade detail and chart gaps without scripts from API text',async()=>{
  const html=await fs.readFile(path.join(__dirname,'../public/perps-copy-dashboard.html'),'utf8');
  const nodes=new Map(),get=id=>{
    if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',className:'',style:{}});
    return nodes.get(id);
  };
  const window={};
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{
    window,document:{getElementById:get},console,
    fetch:()=>new Promise(()=>{}),setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{},
    AbortController,URL,Date,
  });
  window.__render({});
  const f=fixture();await f.open();const s=f.bot.snapshot();
  s.legs[0].decision='<img src=x onerror=alert(1)>';
  s.equityCurve=[{at:1,equity:5000},{at:2,equity:null},{at:3,equity:4990}];
  window.__render(s);
  assert.match(get('legs').innerHTML,/Margin units/);assert.doesNotMatch(get('legs').innerHTML,/<img/);
  assert.match(get('legs').innerHTML,/original anchor/);assert.match(get('trades').innerHTML,/OPEN/);
  assert.match(get('chart').innerHTML,/<path d="M[^"]*M/);
  f.advance(20000);window.__render(f.bot.snapshot());
  assert.match(get('equity').textContent,/unknown/i);
});
