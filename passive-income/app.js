(() => {
  'use strict';

  const DB_NAME = 'sharecapsule-income-projects';
  const DB_VERSION = 1;
  const STORE = 'workspace';
  const STATE_ID = 'state';
  const KEY_ID = 'device-key';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const IDEAS = [
    { id:'templates', title:'Digital templates', category:'digital', effort:'Medium', cost:'Low', time:'2–4 weeks', summary:'Create reusable Canva, spreadsheet, resume, planner or business templates and sell the same files repeatedly.', milestones:['Choose one narrow audience','Create 5–10 useful templates','Prepare preview images and instructions','Publish on a marketplace or your own site','Get first customer feedback and improve'] },
    { id:'ebook', title:'Practical e-book or guide', category:'content', effort:'Medium', cost:'Low', time:'3–6 weeks', summary:'Turn real expertise into a focused guide that solves one specific problem and can be sold repeatedly.', milestones:['Define reader and one outcome','Create chapter outline','Draft and edit the guide','Design cover and sample pages','Publish and collect reader feedback'] },
    { id:'micro-saas', title:'Micro SaaS / small web tool', category:'technology', effort:'High', cost:'Medium', time:'4–12 weeks', summary:'Build a narrowly focused subscription or paid utility that automates a repetitive task for a specific audience.', milestones:['Interview or observe target users','Define one painful workflow','Build minimum usable version','Add simple pricing and onboarding','Get first 3 paying or committed users'] },
    { id:'course', title:'Recorded mini-course', category:'content', effort:'High', cost:'Low', time:'4–8 weeks', summary:'Record a short outcome-oriented course that can be sold repeatedly with periodic updates.', milestones:['Choose one teachable outcome','Design 5–8 short lessons','Record and edit lessons','Create worksheets/resources','Publish and gather completion feedback'] },
    { id:'affiliate', title:'Niche resource / affiliate site', category:'content', effort:'Medium', cost:'Low', time:'6–12 weeks', summary:'Build genuinely useful comparison or educational content and earn commissions only when relevant products or services are chosen.', milestones:['Pick a narrow problem area','Research useful topics and products','Publish 10 high-quality pages','Add clear affiliate disclosures','Measure useful traffic and conversions'] },
    { id:'printables', title:'Printables and planners', category:'digital', effort:'Low', cost:'Low', time:'1–3 weeks', summary:'Create checklists, trackers, worksheets or planners that customers can download and print on demand.', milestones:['Pick one repeatable use case','Create first product set','Test printing and usability','Publish listing and previews','Create second product from feedback'] },
    { id:'licensing', title:'Photo, audio or video licensing', category:'creative', effort:'Medium', cost:'Low', time:'4–8 weeks', summary:'Build a reusable library of original photos, sound effects, music, footage or graphics that can earn licensing revenue over time.', milestones:['Choose a licensable niche','Create first 25 quality assets','Organize metadata and releases','Publish to selected marketplaces','Track downloads and expand winners'] },
    { id:'newsletter', title:'Specialized newsletter', category:'content', effort:'Medium', cost:'Low', time:'6–12 weeks', summary:'Build a focused recurring publication, then monetize later through sponsorships, memberships or products after earning trust.', milestones:['Define exact reader promise','Publish 4 useful issues','Create a simple subscribe page','Reach first 100 engaged subscribers','Test one appropriate monetization method'] },
    { id:'api', title:'Paid API or data utility', category:'technology', effort:'High', cost:'Medium', time:'4–10 weeks', summary:'Package a useful transformation, validation, aggregation or workflow capability behind a simple paid API.', milestones:['Define one API job to be done','Build reliable endpoint and docs','Add usage limits and error handling','Create sample integration','Get first external developer user'] },
    { id:'pod', title:'Print-on-demand designs', category:'creative', effort:'Medium', cost:'Low', time:'3–6 weeks', summary:'Create original designs for products produced only after an order, avoiding inventory while testing demand.', milestones:['Choose a narrow audience','Create 10 original designs','Order/test one sample','Publish product listings','Track which themes get real interest'] },
    { id:'membership', title:'Resource membership', category:'digital', effort:'High', cost:'Medium', time:'6–12 weeks', summary:'Offer a growing library of valuable templates, research, prompts, datasets or tools for a recurring membership fee.', milestones:['Define recurring value promise','Create initial member library','Set update cadence','Launch to first small cohort','Measure retention before expanding'] },
    { id:'rental', title:'Rent an underused asset', category:'local', effort:'Low', cost:'Low', time:'1–4 weeks', summary:'Generate income from an underused legal asset such as parking, storage, equipment or other locally rentable capacity where permitted.', milestones:['Identify a suitable underused asset','Check insurance, lease and local rules','Set pricing and availability','Create safe listing/process','Complete first rental and review risks'] }
  ];

  let db;
  let deviceKey;
  let state = { version:1, focusProjectId:null, projects:[] };
  let activeFilter = 'all';

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const money = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
  const today = () => new Date().toISOString();

  function openDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,DB_VERSION);request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'id'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  function dbGet(id){return new Promise((resolve,reject)=>{const request=db.transaction(STORE,'readonly').objectStore(STORE).get(id);request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);});}
  function dbPut(value){return new Promise((resolve,reject)=>{const request=db.transaction(STORE,'readwrite').objectStore(STORE).put(value);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});}

  async function ensureDeviceKey(){
    const existing=await dbGet(KEY_ID);
    if(existing?.key)return existing.key;
    const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    await dbPut({id:KEY_ID,key,createdAt:today()});
    return key;
  }

  function b64(bytes){let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);}
  function unb64(value){const binary=atob(value);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;}

  async function loadState(){
    const record=await dbGet(STATE_ID);
    if(!record)return;
    try{
      const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(record.iv)},deviceKey,unb64(record.ciphertext));
      const parsed=JSON.parse(decoder.decode(plain));
      if(parsed&&Array.isArray(parsed.projects))state={version:1,focusProjectId:parsed.focusProjectId||null,projects:parsed.projects.slice(0,100)};
    }catch(error){console.error('Could not decrypt income project workspace',error);}
  }

  async function saveState(){
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},deviceKey,encoder.encode(JSON.stringify(state)));
    await dbPut({id:STATE_ID,format:'sharecapsule-income-projects-v1',iv:b64(iv),ciphertext:b64(new Uint8Array(ciphertext)),updatedAt:today()});
    const indicator=$('saveStatus');if(indicator)indicator.textContent=`Saved on this device · ${new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`;
  }

  function findIdea(id){return IDEAS.find((idea)=>idea.id===id);}
  function findProject(id){return state.projects.find((project)=>project.id===id);}
  function focusProject(){return findProject(state.focusProjectId);}
  function activeProjectExists(){const project=focusProject();return Boolean(project&&project.status==='active');}

  function renderIdeas(){
    const visible=IDEAS.filter((idea)=>activeFilter==='all'||idea.category===activeFilter);
    const active=activeProjectExists();
    $('ideaGrid').innerHTML=visible.map((idea)=>{
      const existing=state.projects.find((project)=>project.ideaId===idea.id&&project.status!=='archived');
      const button=existing?`<button class="secondary" data-open-project="${esc(existing.id)}" type="button">View project</button>`:active?'<button class="primary" type="button" disabled>Finish current focus first</button>':`<button class="primary" data-start-idea="${esc(idea.id)}" type="button">Start this project</button>`;
      return `<article class="idea-card"><div class="tags"><span class="tag">${esc(idea.category)}</span><span class="tag">${esc(idea.effort)} effort</span></div><h3>${esc(idea.title)}</h3><p>${esc(idea.summary)}</p><div class="idea-meta"><div><span>Startup cost</span><strong>${esc(idea.cost)}</strong></div><div><span>First version</span><strong>${esc(idea.time)}</strong></div><div><span>Maintenance</span><strong>${idea.effort==='Low'?'Low':idea.effort==='Medium'?'Moderate':'Higher initially'}</strong></div></div><div class="button-row">${button}</div></article>`;
    }).join('');
  }

  function startIdea(ideaId){
    if(activeProjectExists())return;
    const idea=findIdea(ideaId);if(!idea)return;
    const project={id:uid(),ideaId:idea.id,title:idea.title,status:'active',progress:0,startedAt:today(),completedAt:null,monthlyIncome:0,milestones:idea.milestones.map((text)=>({id:uid(),text,done:false})),updates:[{id:uid(),at:today(),progress:0,note:'Project started.',monthlyIncome:0}]};
    state.projects.push(project);state.focusProjectId=project.id;saveState();renderAll();document.getElementById('focus').scrollIntoView({behavior:'smooth'});
  }

  function renderFocus(){
    const project=focusProject();
    if(!project){$('focusProject').innerHTML='<div class="panel focus-empty"><p class="eyebrow">No current focus</p><h3>Choose one idea and finish the first useful version.</h3><p class="muted">A focused project usually teaches more than starting five ideas at once.</p></div>';return;}
    const idea=findIdea(project.ideaId);
    const completed=project.status==='completed';
    const completedMilestones=project.milestones.filter((item)=>item.done).length;
    $('focusProject').innerHTML=`<div class="project-layout"><article class="project-card"><div class="project-head"><div><p class="eyebrow">${completed?'Completed project':'Current focus'}</p><h3>${esc(project.title)}</h3><p class="muted">Started ${esc(new Date(project.startedAt).toLocaleDateString())}${project.completedAt?` · completed ${esc(new Date(project.completedAt).toLocaleDateString())}`:''}</p></div><span class="status ${completed?'completed':''}">${completed?'Completed':'Active'}</span></div><div class="kpis"><div class="kpi"><span>Progress</span><strong>${Math.round(project.progress)}%</strong></div><div class="kpi"><span>Milestones</span><strong>${completedMilestones}/${project.milestones.length}</strong></div><div class="kpi"><span>Latest monthly result</span><strong>${project.monthlyIncome>0?esc(money.format(project.monthlyIncome)):'—'}</strong></div></div><div class="progress-wrap"><div class="progress-top"><span>Project progress</span><span>${Math.round(project.progress)}%</span></div><div class="progress-track"><div class="progress-bar" style="width:${Math.max(0,Math.min(100,project.progress))}%"></div></div></div><h3>Milestones</h3><div class="milestones">${project.milestones.map((item)=>`<div class="milestone"><input id="m-${esc(item.id)}" data-milestone="${esc(item.id)}" type="checkbox" ${item.done?'checked':''} ${completed?'disabled':''}><label for="m-${esc(item.id)}">${esc(item.text)}</label></div>`).join('')}</div>${completed?'<p class="small-note">The project is complete, but you can keep adding post-launch updates and monthly results below.</p>':'<div class="button-row"><button class="primary" data-complete-project type="button">Mark project complete</button></div>'}</article><article class="project-card"><p class="eyebrow">Progress update</p><h3>${completed?'Log a post-launch result':'Update your work'}</h3>${completed?'':`<label class="field"><span>Progress %</span><input id="projectProgress" type="number" min="0" max="99" step="1" value="${Math.round(project.progress)}"></label>`}<label class="field"><span>${completed?'Monthly income/result (optional)':'Current monthly income/result (optional)'}</span><input id="projectIncome" type="number" min="0" step="1" value="${project.monthlyIncome||''}" placeholder="0"></label><label class="field"><span>What changed?</span><textarea id="projectNote" maxlength="500" placeholder="What did you finish, learn, publish, test or improve?"></textarea></label><button class="primary" data-save-update type="button">Save progress update</button><p class="small-note">Do not enter passwords, card/account numbers, API secrets or other confidential credentials.</p><h3 style="margin-top:22px">Update history</h3><div class="history">${[...project.updates].reverse().slice(0,12).map((update)=>`<div class="history-item"><strong>${esc(new Date(update.at).toLocaleString())} · ${Math.round(update.progress)}%</strong><span>${esc(update.note||'Progress updated.')}${update.monthlyIncome>0?` · Monthly result: ${esc(money.format(update.monthlyIncome))}`:''}</span></div>`).join('')}</div></article></div>`;
  }

  function renderPortfolio(){
    const completed=state.projects.filter((project)=>project.status==='completed');
    const active=state.projects.filter((project)=>project.status==='active');
    const totalMonthly=state.projects.reduce((sum,project)=>sum+Math.max(0,Number(project.monthlyIncome)||0),0);
    $('portfolioSummary').innerHTML=`<div class="kpis"><div class="kpi"><span>Active focus</span><strong>${active.length}</strong></div><div class="kpi"><span>Completed</span><strong>${completed.length}</strong></div><div class="kpi"><span>Latest monthly results</span><strong>${totalMonthly?esc(money.format(totalMonthly)):'—'}</strong></div></div>`;
    $('projectPortfolio').innerHTML=state.projects.length?[...state.projects].sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt))).map((project)=>`<article class="project-card"><div class="project-head"><div><h3>${esc(project.title)}</h3><p class="muted">${project.status==='completed'?'Completed':'Active'} · ${Math.round(project.progress)}% · started ${esc(new Date(project.startedAt).toLocaleDateString())}</p></div><span class="status ${project.status==='completed'?'completed':''}">${esc(project.status)}</span></div><div class="button-row"><button class="secondary" data-open-project="${esc(project.id)}" type="button">${project.id===state.focusProjectId?'Open focus':'View / update'}</button></div></article>`).join(''):'<div class="empty">Your income-project history will appear here after you start the first idea.</div>';
  }

  function renderAll(){renderIdeas();renderFocus();renderPortfolio();}

  async function saveUpdate(){
    const project=focusProject();if(!project)return;
    const completed=project.status==='completed';
    if(!completed){project.progress=Math.max(0,Math.min(99,Number($('projectProgress')?.value)||0));}
    project.monthlyIncome=Math.max(0,Number($('projectIncome')?.value)||0);
    const note=String($('projectNote')?.value||'').trim().slice(0,500);
    project.updates.push({id:uid(),at:today(),progress:project.progress,note:note||'Progress updated.',monthlyIncome:project.monthlyIncome});
    await saveState();renderAll();
  }

  async function completeProject(){
    const project=focusProject();if(!project||project.status!=='active')return;
    if(!confirm('Mark this project complete? You can still log post-launch results afterward.'))return;
    project.status='completed';project.progress=100;project.completedAt=today();project.milestones.forEach((item)=>{if(item.done!==true)item.done=item.done;});project.updates.push({id:uid(),at:today(),progress:100,note:'Project marked complete. Post-launch tracking remains available.',monthlyIncome:project.monthlyIncome});
    state.focusProjectId=project.id;await saveState();renderAll();
  }

  async function toggleMilestone(id,checked){const project=focusProject();if(!project||project.status!=='active')return;const milestone=project.milestones.find((item)=>item.id===id);if(!milestone)return;milestone.done=checked;const done=project.milestones.filter((item)=>item.done).length;project.progress=Math.max(project.progress,Math.min(95,Math.round((done/project.milestones.length)*90)));await saveState();renderAll();}

  function openProject(id){const project=findProject(id);if(!project)return;if(project.status==='active'||!activeProjectExists())state.focusProjectId=id;else if(project.status==='completed')state.focusProjectId=id;renderAll();document.getElementById('focus').scrollIntoView({behavior:'smooth'});}

  function bind(){
    document.addEventListener('click',(event)=>{
      const filter=event.target.closest('[data-filter]');if(filter){activeFilter=filter.dataset.filter;document.querySelectorAll('[data-filter]').forEach((node)=>node.classList.toggle('active',node===filter));renderIdeas();return;}
      const start=event.target.closest('[data-start-idea]');if(start){startIdea(start.dataset.startIdea);return;}
      const open=event.target.closest('[data-open-project]');if(open){openProject(open.dataset.openProject);return;}
      if(event.target.closest('[data-save-update]')){saveUpdate();return;}
      if(event.target.closest('[data-complete-project]')){completeProject();return;}
    });
    document.addEventListener('change',(event)=>{if(event.target.matches('[data-milestone]'))toggleMilestone(event.target.dataset.milestone,event.target.checked);});
  }

  async function init(){
    if(!window.crypto?.subtle||!window.indexedDB){document.body.innerHTML='<div class="shell"><div class="notice">This browser does not provide the local encryption and storage features required for the income-project workspace.</div></div>';return;}
    db=await openDb();deviceKey=await ensureDeviceKey();await loadState();bind();renderAll();$('saveStatus').textContent='Encrypted project progress stays on this device';
  }

  init().catch((error)=>{console.error(error);$('saveStatus').textContent='Could not open the local project workspace';});
})();