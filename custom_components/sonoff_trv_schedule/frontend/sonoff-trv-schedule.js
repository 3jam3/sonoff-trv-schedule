const VERSION='1.0.2';

class SonoffTrvSchedulePanel extends HTMLElement {
  set hass(v){
    const language=this.normalizeLanguage(v?.language);
    const languageChanged=this._started&&language!==this._language;
    this._hass=v;
    if(!this._started){
      this._started=true;
      this.init();
    }else if(languageChanged){
      this.loadTranslations(language).then(()=>this.render());
    }
  } set panel(v){this._panel=v;}

  async init(){
    this.mode='existing';
    this.group='Schedule_1';
    this.targetGroup=this.group;
    this.sourceDay=2;
    this.selectedDays=new Set();
    this.periods=[];
    this.dirty=false;
    this.busy=false;
    this.status='';
    this.loadExistingPrompt=false;
    await this.loadTranslations();
    try{
      this.devices=await this._hass.callWS({type:'sonoff_trv_schedule/devices'});
    }catch(e){
      this.devices=[];
      this.status=this.t('error_backend',{error:e.message||e});
    }
    this.render();
  }

  normalizeLanguage(language){
    return String(language||'en').replace(/_/g,'-').toLowerCase().split('-')[0];
  }

  async loadTranslations(language=this.normalizeLanguage(this._hass?.language)){
    const load=async(lang)=>{
      const r=await fetch(`/sonoff_trv_schedule/lang/${lang}.json`,{cache:'no-store'});
      if(!r.ok)throw new Error(`Translation load failed: ${r.status} ${r.statusText}`);
      const data=await r.json();
      if(!data?.panel||!Object.keys(data.panel).length){
        throw new Error(`No panel translations for language: ${lang}`);
      }
      return data.panel;
    };

    this._translationLoadFailed=false;

    try{
      this._translations=await load(language);
    }catch(e){
      if(language==='en')console.error(e);
      if(language!=='en'){
        // A missing language file is expected: fall back to English silently.
        try{
          this._translations=await load('en');
        }catch(fallbackError){
          console.error(fallbackError);
          this._translations={};
          this._translationLoadFailed=true;
        }
      }else{
        this._translations={};
        this._translationLoadFailed=true;
      }
    }

    this._language=language;
  }

  get device(){return this._device||this.devices?.[0]?.id||'';} get targetDevice(){return this._targetDevice||this.device;} get days(){return [2,4,8,16,32,64,1];}

  dayName(d){return this.t(({2:'monday',4:'tuesday',8:'wednesday',16:'thursday',32:'friday',64:'saturday',1:'sunday'})[d]||String(d));}

  t(key,params={}){
    const text=this._translations?.[key]??key;
    return String(text).replace(/\{(\w+)\}/g,(_,k)=>params[k]??`{${k}}`);
  }
  short(d){return this.t(({2:'mon',4:'tue',8:'wed',16:'thu',32:'fri',64:'sat',1:'sun'})[d]||String(d));}
  escapeHtml(text){return String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  formatStatus(text){const safe=this.escapeHtml(text);const colon=safe.indexOf(':');return colon<0?safe:`<strong>${safe.slice(0,colon+1)}</strong>${safe.slice(colon+1)}`;}
  formatDays(days){
    const normalized=[...new Set(days.map(d=>Number(d)))].filter(d=>this.days.includes(d));
    const sorted=normalized.sort((a,b)=>this.days.indexOf(a)-this.days.indexOf(b));
    const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
    if(same(sorted,this.days))return this.t('all_days');
    if(same(sorted,this.days.slice(0,5)))return this.t('weekdays');
    if(same(sorted,this.days.slice(5)))return this.t('weekends');
    return sorted.map(d=>this.dayName(d)).join(', ');
  }
  timeOptions(){let x='';for(let m=0;m<1440;m+=30)x+=`<option value="${m}">${String(m/60|0).padStart(2,'0')}:${String(m%60).padStart(2,'0')}</option>`;return x;}
  updateDayControls(){
    this.querySelectorAll('[data-day]').forEach(e=>{
      e.classList.toggle('dayon',this.selectedDays.has(Number(e.dataset.day)));
    });
    const apply=this.querySelector('#apply');
    if(apply){
      apply.textContent=this.t('apply_verify',{count:this.selectedDays.size});
      apply.disabled=this.busy||!this.periods.length||!this.selectedDays.size;
    }
  }
  setPreset(w){
    let d=w==='weekdays'?this.days.slice(0,5):w==='weekends'?this.days.slice(5):this.days;
    this.selectedDays=new Set(d);
    this.updateDayControls();
  }
  toggleDay(d){
    this.selectedDays.has(d)?this.selectedDays.delete(d):this.selectedDays.add(d);
    this.updateDayControls();
  }
  clearDays(){
    this.selectedDays.clear();
    this.updateDayControls();
  }
  setStatus(text,type='info'){this.status=text;this.statusType=type;}  
  resetTarget(){this._targetDevice='';this.targetGroup=this.group;}
  newSchedule(){this.loadExistingPrompt=false;this.mode='new';this.resetTarget();this.periods=[{minutes:0,temperature:20}];this.dirty=true;this.setStatus(this.t('status_new_schedule'),'info');this.render();}
  validate(){if(!this.selectedDays.size)return this.t('validation_select_day');if(!this.periods.length||this.periods.length>12)return this.t('validation_period_count');if(this.periods[0].minutes!==0)return this.t('validation_first_period');for(let i=0;i<this.periods.length;i++){let p=this.periods[i];if(p.minutes<0||p.minutes>=1440||p.minutes%30)return this.t('validation_time_step',{period:i+1});if(p.temperature<5||p.temperature>30||Math.abs(p.temperature*2-Math.round(p.temperature*2))>.001)return this.t('validation_temperature',{period:i+1});if(i&&p.minutes<=this.periods[i-1].minutes)return this.t('validation_period_order',{period:i+1,previous:i});}return '';}
  async fetchSchedule(){if(!this.device||this.busy)return;this.loadExistingPrompt=false;this.mode='existing';this.busy=true;this.setStatus(this.t('status_fetching',{day:this.dayName(this.sourceDay)}),'warning');this.render();try{let r=await this._hass.callWS({type:'sonoff_trv_schedule/fetch',device_id:this.device,group:this.group,day:this.sourceDay});this.periods=r.periods;this.dirty=false;this.setStatus(this.t('status_loaded',{day:this.dayName(this.sourceDay),count:r.periods.length}),'info');}catch(e){this.setStatus(this.t('error_fetch',{error:e.message||e}),'error');}this.busy=false;this.render();}
  async confirmWrite(count){
    return new Promise((resolve)=>{
      const dialog=document.createElement('ha-dialog');
      dialog.setAttribute('open','');
      dialog.setAttribute('header-title',this.t('title'));

      const message=document.createElement('div');
      const deviceName=this.devices?.find(
        d=>d.id===this.targetDevice
      )?.name||this.targetDevice;
      const scheduleName=(this.targetGroup||this.group).replace('_',' ');

      const prompt=document.createElement('div');
      prompt.textContent=this.t('confirm_write');

      const target=document.createElement('div');
      target.textContent=`${scheduleName} ➜ ${deviceName}`;
      target.style.fontWeight='600';
      target.style.color='var(--warning-color,#ff9800)';
      target.style.marginTop='16px';

      const days=document.createElement('div');
      days.textContent=this.t('selected_days_count',{count});
      days.style.marginTop='8px';

      message.append(prompt,target,days);
      message.style.padding='0 24px 24px';

      const footer=document.createElement('ha-dialog-footer');
      const cancel=document.createElement('ha-button');
      cancel.setAttribute('slot','secondaryAction');
      cancel.setAttribute('appearance','plain');
      cancel.textContent=this._hass.localize('ui.common.cancel');

      const confirm=document.createElement('ha-button');
      confirm.setAttribute('slot','primaryAction');
      confirm.setAttribute('variant','brand');
      confirm.setAttribute('appearance','filled');
      confirm.textContent=this._hass.localize('ui.common.ok');

      let done=false;
      const finish=(result)=>{
        if(done)return;
        done=true;
        dialog.open=false;
        dialog.removeAttribute('open');
        resolve(result);
      };

      cancel.addEventListener('click',()=>finish(false));
      confirm.addEventListener('click',()=>finish(true));

      dialog.addEventListener('closed',()=>{
        dialog.remove();
        if(!done){
          done=true;
          resolve(false);
        }
      });

      footer.append(cancel,confirm);
      dialog.append(message,footer);
      document.body.append(dialog);
    });
  }

  async applySchedule(){if(this.busy)return;let err=this.validate();if(err){this.setStatus(err,'error');this.render();return;}let days=this.days.filter(d=>this.selectedDays.has(d));if(!(await this.confirmWrite(days.length)))return;this.busy=true;this.setStatus(this.t('status_writing',{count:days.length}),'warning');this.render();try{let r=await this._hass.callWS({type:'sonoff_trv_schedule/apply',device_id:this.targetDevice,group:this.targetGroup||this.group,days,periods:this.periods});this.dirty=false;let parts=[];if(r.days?.length)parts.push(this.t('status_verified',{days:this.formatDays(r.days)}));if(r.unverified?.length)parts.push(this.t('status_unverified',{days:this.formatDays(r.unverified.map(x=>x.day))}));if(r.failed?.length)parts.push(this.t('status_write_failed',{days:this.formatDays(r.failed.map(x=>x.day))}));this.selectedDays.clear();this.targetGroup=this.group;this.setStatus(parts.join(' '),(r.unverified?.length||r.failed?.length)?'warning':'info');}catch(e){this.setStatus(this.t('error_apply',{error:e.message||e}),'error');}this.busy=false;this.render();}
  mark(){this.dirty=true;this.setStatus(this.t('status_edited'),'info');}
  addPeriod(){if(this.periods.length>=12)return;let l=this.periods.at(-1),m=l?l.minutes+30:0;if(m>=1440)return;this.periods.push({minutes:m,temperature:l?.temperature??20});this.mark();this.render();}

  render(){
    if(this._translationLoadFailed){
      this.innerHTML=`
        <div style="
          min-height:70vh;
          display:flex;
          align-items:center;
          justify-content:center;
          padding:24px;
          box-sizing:border-box;
          color:var(--primary-text-color);
          font-family:Roboto,Arial,sans-serif;
        ">
          <div style="
            display:flex;
            align-items:center;
            gap:12px;
            font-size:20px;
            font-weight:500;
            text-align:center;
          ">
            <ha-icon icon="mdi:information-outline"></ha-icon>
            <span>Unable to load panel translations.</span>
          </div>
        </div>
      `;
      return;
    }
    const editSteps=['edit_step_1','edit_step_2','edit_step_3','edit_step_4','edit_step_5'];
    const newSteps=['new_step_1','new_step_2','new_step_3','new_step_4'];
    const steps=this.mode==='existing'?editSteps:newSteps;
    const importantKey=this.mode==='existing'?'edit_important':'new_important';
    const titleKey=this.mode==='existing'?'edit_existing':'create_new';
    const aboutText=this.t('about_text');

    this.innerHTML=`
      <style>
        :host{display:block;min-height:100vh;background:var(--primary-background-color);color:var(--primary-text-color);font-family:Roboto,Arial,sans-serif}
        .card{width:100%;max-width:1000px;margin:0 auto;padding:24px;box-sizing:border-box;background:transparent;border-radius:0;box-shadow:none}
        .info-panel{background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;box-sizing:border-box;margin:0 0 18px;padding:18px 20px}
        .info-panel .about{background:transparent;border:0;border-radius:0;margin:0;padding:0}
        h1{font-size:28px;line-height:1.25;margin:0 0 4px;font-weight:600}.sub{color:var(--secondary-text-color);font-size:14px;margin-bottom:28px}
        .section-title{display:flex;align-items:center;gap:6px;font-size:15px;font-weight:600;margin-bottom:6px}.section-title .about-info{display:inline-flex;align-items:center;justify-content:center;color:var(--secondary-text-color)}.section-title .about-info ha-icon{--mdc-icon-size:22px;width:22px;height:22px}
        .about,.grid{background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;box-sizing:border-box}
        .section,.schedule-editor,.writebox{background:transparent;border:0;border-radius:0;box-sizing:border-box}.days-panel{background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;box-sizing:border-box;margin-top:16px;padding:16px 18px}.days-panel>.hint{margin-bottom:8px}
        .about{color:var(--secondary-text-color);font-size:14px;line-height:1.55;margin:0 0 18px;padding:18px 20px}
        .help{margin:0 0 18px;padding:0;border:1px solid var(--divider-color);border-radius:12px;background:var(--card-background-color);font-size:14px;line-height:1.5;overflow:hidden}
        .help summary{cursor:pointer;font-weight:500;padding:14px 18px}.help ol{margin:0;padding:0 38px 10px}.note{color:var(--secondary-text-color);font-size:13px;padding:0 18px 15px}
        .note b{color:var(--warning-color,#e6a100)}
        .grid{display:grid;grid-template-columns:minmax(260px,auto) minmax(0,1fr);gap:22px;align-items:center;padding:18px 20px}
        .grid>label{display:contents}.grid .section-title{margin:0}.grid select{margin-top:0}
        .schedule-selection{display:grid;grid-template-columns:minmax(220px,300px) minmax(220px,300px);gap:10px;align-items:end}
        .mode-row{display:flex;align-items:flex-start;gap:24px;margin:18px 0}.tabs{display:flex;gap:8px;margin:0;flex:0 0 auto}.mode-help{flex:1;min-width:0;margin:0;background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;padding:0 18px;box-sizing:border-box;font-size:14px;line-height:1.5}.mode-help summary{cursor:pointer;font-weight:500;padding:9px 0;display:inline-block}.mode-help summary:focus{outline:none}.mode-help-head>details{display:block}.mode-help-head>details>summary{display:flex;align-items:center;width:max-content;gap:6px;list-style:none}.mode-help-head>details>summary::-webkit-details-marker{display:none}.mode-help-head>details>summary::before{content:"▶";font-size:10px;color:var(--secondary-text-color);display:inline-block;width:12px}.mode-help-head>details[open]>summary::before{content:"▼"}.mode-help-info{display:inline-flex;align-items:center;justify-content:center;color:var(--secondary-text-color);cursor:help}.mode-help-info ha-icon{--mdc-icon-size:22px;width:22px;height:22px}.mode-help ol{margin:4px 0 0;padding:12px 16px 0 38px}.mode-help .note{padding:6px 16px 12px}.mode-help-head > details[open] ol{
          border:0;
          background:transparent;
          padding-top:18px;
        }
        .mode-help-head > details[open] .note{
          border:0;
          background:transparent;
          padding:6px 20px 18px;
        }
        .tabs button,.actions button,.days button,.presets button{width:auto}
        .tabs button{border-radius:20px;padding:8px 16px;margin-top:0;min-height:40px}
        #existing.tabon,
        #new.tabon{
          background:var(--success-color,#4caf50)!important;
          color:#fff!important;
          border-color:var(--success-color,#4caf50)!important;
        }
        #existing:not(.tabon):hover,
        #new:not(.tabon):hover{
          border-color:var(--success-color,#4caf50);
          background:color-mix(
            in srgb,
            var(--success-color,#4caf50) 10%,
            var(--card-background-color)
          );
        }
        #existing.tabon:hover,#new.tabon:hover{filter:brightness(1.08)}
        #existing:focus-visible,
        #new:focus-visible{
          outline:2px solid color-mix(
            in srgb,
            var(--success-color,#4caf50) 65%,
            transparent
          );
          outline-offset:2px;
        }
        .primary{background:var(--primary-color)!important;color:var(--text-primary-color)!important;border-color:var(--primary-color)!important;border-radius:20px;font-weight:500;padding:8px 18px;margin-top:0;min-height:40px;box-shadow:none}
        .primary:hover:not(:disabled){filter:brightness(1.08)}
        .primary:focus-visible{outline:2px solid color-mix(in srgb,var(--primary-color) 65%,transparent);outline-offset:2px}
        label,.hint{color:var(--secondary-text-color);font-size:14px}
        select,input,button{box-sizing:border-box;width:100%;font:inherit;color:var(--primary-text-color);background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:8px;padding:10px 12px;margin-top:6px;min-height:40px}
        select:focus:not(:focus-visible){outline:none}select:focus-visible{outline:2px solid color-mix(in srgb,var(--primary-color) 65%,transparent);outline-offset:2px}
        button{cursor:pointer;transition:background-color .15s ease,border-color .15s ease,color .15s ease,filter .15s ease,outline-color .15s ease}button:hover:not(:disabled){border-color:var(--primary-color)}button:disabled{opacity:.45;cursor:default}
        .section{margin-top:0;padding:0}.source-field{display:block;max-width:300px}.new-schedule-section .hint{margin-top:10px}.new-schedule-section + .status{margin-top:14px}
        .actions{display:flex;gap:10px;margin-top:14px;align-items:flex-end;flex-wrap:wrap}
        .status{padding:4px 0;background:transparent;border:0;border-radius:0;margin:18px 0;font-size:14px}
        .status-warning,.status-hint{color:var(--warning-color,#e6a100);font-weight:500}.status-error{color:var(--error-color,#db4437);font-weight:500}
        .schedule-editor{margin-top:18px;padding:0}.head,.period{display:grid;grid-template-columns:42px 200px 150px 42px;gap:10px;align-items:center}.head{color:var(--secondary-text-color);font-size:13px}.period{margin:7px 0}
        .empty{padding:30px;text-align:center;color:var(--secondary-text-color);font-size:14px;border:1px dashed var(--divider-color);border-radius:10px;background:var(--secondary-background-color)}
        .schedule-empty{color:var(--primary-text-color);font-size:14px;font-weight:600;padding:4px 0;margin:18px 0}
        .writebox{margin-top:10px;padding:10px 0 0;border-top:1px solid var(--divider-color)}.writebox>.actions{margin-top:8px;align-items:center}.writebox.new-mode{margin-top:8px;padding-top:0;border-top:0}.writebox.new-mode>.actions{margin-top:8px}
        .write-target{background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;padding:16px 18px;box-sizing:border-box;margin-top:10px}
        .write-target>.write-title{margin:0 0 8px}.write-target>.hint{margin-bottom:8px}.write-target-heading{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}.write-target-heading .write-title{margin:0}.write-target-heading select{width:auto;min-width:150px;max-width:100%}.write-target-heading select.target-device-select{min-width:260px}
        .writebox #apply{width:auto;min-width:140px;max-width:none;flex:0 0 auto;white-space:nowrap;padding-left:20px;padding-right:20px;margin-top:8px}.writebox.new-mode #apply{margin-top:8px}
        .destination-buttons{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;margin:0}
        .days{display:flex;flex-wrap:wrap;gap:8px;margin:0}
        .days button,.presets button{min-height:34px;padding:6px 13px;border-radius:18px;margin-top:0;background:var(--card-background-color)}
        .dayon{background:var(--primary-color)!important;color:var(--text-primary-color)!important;border-color:var(--primary-color)!important;font-weight:500}
        .days button:focus-visible,.presets button:focus-visible{outline:2px solid color-mix(in srgb,var(--primary-color) 65%,transparent);outline-offset:2px}
        .presets{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 0 10px}.presets #clearDays{margin-left:10px}.final{margin-top:14px}
        #add{border-radius:20px;padding:8px 16px;margin-top:0}
        #add:focus-visible{outline:2px solid color-mix(in srgb,var(--primary-color) 65%,transparent);outline-offset:2px}
        @media(max-width:700px){.card{padding:22px 14px 46px}.mode-row{flex-direction:column;gap:8px}.mode-help{width:100%}.writebox #apply{min-width:0}.presets{margin-left:4px}.presets #clearDays{margin-left:4px}.grid{grid-template-columns:1fr;gap:8px}.grid>label{display:block}.grid .section-title{margin-bottom:6px}.grid select{margin-top:6px}.schedule-selection{grid-template-columns:1fr}.head,.period{grid-template-columns:30px minmax(0,1fr) minmax(0,1fr) 38px}.source-field{max-width:none}}
      </style>

      <div class="card">
        <h1>${this.t('title')}</h1>
        <div class="sub">v${VERSION}</div>

        <div class="info-panel">
          <div class="about">
            <span class="section-title"><span>${this.t('about_title')}</span><span class="about-info" title="Information" aria-label="Information"><ha-icon icon="mdi:information-outline"></ha-icon></span></span>
            ${aboutText}
          </div>
        </div>

        ${this.devices?.length ? `
          <div class="grid">
            <label>
              <span class="section-title">${this.t('select_trv')}</span>
              <select id="device" ${this.busy?'disabled':''}>
                ${this.devices.map(d=>`<option value="${this.escapeHtml(d.id)}" ${d.id===this.device?'selected':''}>${this.escapeHtml(d.name)}</option>`).join('')}
              </select>
            </label>
          </div>

          <div class="mode-row">
            <div class="tabs">
              <button id="existing" class="${this.mode==='existing'?'tabon':''}">${this.t('load_existing')}</button>
              <button id="new" class="${this.mode==='new'?'tabon':''}">${this.t('new_schedule')}</button>
            </div>
            <div class="mode-help">
              <div class="mode-help-head">
                <details>
                  <summary><span>${this.t(titleKey)}</span><span class="mode-help-info" title="Information" aria-label="Information"><ha-icon icon="mdi:information-outline"></ha-icon></span></summary>
                  <ol>${steps.map(key=>`<li>${this.t(key)}</li>`).join('')}</ol>
                  <div class="note"><b>${this.t('important')}</b> ${this.t(importantKey)}</div>
                </details>
              </div>
              <div style="display:none"></div>
            </div>
          </div>

          ${this.mode==='existing' ? `
            <div class="section">
              <div class="actions">
                <button id="fetch" class="primary" ${this.busy?'disabled':''}>${this.t('fetch_edit')}</button>
                <div class="schedule-selection">
                  <label class="source-field">
                    ${this.t('select_schedule_group')}
                    <select id="group" ${this.busy?'disabled':''}>
                      ${[1,2,3].map(n=>`<option value="Schedule_${n}" ${this.group===`Schedule_${n}`?'selected':''}>Schedule ${n}</option>`).join('')}
                    </select>
                  </label>
                  <label class="source-field">
                    ${this.t('choose_schedule_day')}
                    <select id="source" ${this.busy?'disabled':''}>
                      ${this.days.map(d=>`<option value="${d}" ${d===this.sourceDay?'selected':''}>${this.dayName(d)}</option>`).join('')}
                    </select>
                  </label>
                </div>
              </div>
            </div>
          ` : `
            <div class="section new-schedule-section">
              <div class="schedule-selection">
                <label class="source-field">
                  ${this.t('select_schedule_group')}
                  <select id="group" ${this.busy?'disabled':''}>
                    ${[1,2,3].map(n=>`<option value="Schedule_${n}" ${this.group===`Schedule_${n}`?'selected':''}>Schedule ${n}</option>`).join('')}
                  </select>
                </label>
              </div>
              <div class="hint">${this.t('new_schedule_hint')}</div>
            </div>
          `}

          ${this.status ? `
            <div class="status status-${this.statusType||'info'}">${this.formatStatus(this.status)}</div>
          ` : ''}

          <div class="schedule-editor">
            ${this.periods.length ? `
              <div class="head"><span>#</span><span>${this.t('start_time')}</span><span>${this.t('temperature')}</span><span></span></div>
              ${this.periods.map((p,i)=>`
                <div class="period">
                  <b>${i+1}</b>
                  <select data-time="${i}" ${i===0||this.busy?'disabled':''}>${this.timeOptions()}</select>
                  <input data-temp="${i}" type="number" min="5" max="30" step="0.5" value="${p.temperature}" ${this.busy?'disabled':''}>
                  <button data-delete="${i}" ${i===0||this.busy?'disabled':''} aria-label="${this.t('delete_period',{period:i+1})}">×</button>
                </div>
              `).join('')}
            ` : `
              ${this.loadExistingPrompt||this.busy ? '' : `<div class="schedule-empty">${this.t('no_schedule_loaded')}</div>`}
            `}
            <div class="actions">
              <button id="add" ${this.busy||!this.periods.length||this.periods.length>=12?'disabled':''}>${this.t('add_period',{count:this.periods.length})}</button>
            </div>
          </div>

          <div class="days-panel">
            <div class="hint">${this.t('fetch_destination_hint')}</div>
            <div class="destination-buttons">
              <div class="days">
                ${this.days.map(d=>`<button data-day="${d}" class="${this.selectedDays.has(d)?'dayon':''}" ${this.busy?'disabled':''}>${this.short(d)}</button>`).join('')}
              </div>
              <div class="presets">
                <button data-preset="weekdays" ${this.busy?'disabled':''}>${this.t('weekdays')}</button>
                <button data-preset="weekends" ${this.busy?'disabled':''}>${this.t('weekends')}</button>
                <button data-preset="all" ${this.busy?'disabled':''}>${this.t('all_days')}</button>
                <button id="clearDays" ${this.busy?'disabled':''}>${this.t('clear')}</button>
              </div>
            </div>
          </div>

          <div class="writebox ${this.mode==='existing'?'existing-mode':'new-mode'}">
            ${this.mode==='existing' ? `
              <div class="write-target">
                <div class="write-target-heading">
                  <span class="section-title write-title">${this.t('write_settings_to')}</span>
                  <select id="targetGroup" ${this.busy?'disabled':''} aria-label="${this.t('write_settings_to')}">
                    ${[1,2,3].map(n=>`<option value="Schedule_${n}" ${(this.targetGroup||this.group)===`Schedule_${n}`?'selected':''}>Schedule ${n}</option>`).join('')}
                  </select>
                  ${this.devices.length>1 ? `
                    <span class="section-title write-title">${this.t('write_to_trv')}</span>
                    <select id="targetDevice" class="target-device-select" ${this.busy?'disabled':''} aria-label="${this.t('write_to_trv')}">
                      ${this.devices.map(d=>`<option value="${this.escapeHtml(d.id)}" ${d.id===this.targetDevice?'selected':''}>${this.escapeHtml(d.name)}</option>`).join('')}
                    </select>
                  ` : ''}
                </div>
              </div>
            ` : ''}
            <div class="actions">
              <button id="apply" class="primary" ${this.busy||!this.periods.length||!this.selectedDays.size?'disabled':''}>${this.t('apply_verify',{count:this.selectedDays.size})}</button>
            </div>
          </div>
        ` : `
          <div class="empty">${this.t('no_devices')}</div>
        `}
      </div>
    `;

    if(!this.devices?.length)return;

    this.periods.forEach((p,i)=>{const e=this.querySelector(`[data-time="${i}"]`);if(e)e.value=p.minutes;});

    this.querySelector('#device').onchange=e=>{this._device=e.target.value;this.resetTarget();this.periods=[];this.selectedDays.clear();this.dirty=false;this.status='';this.statusType='info';this.loadExistingPrompt=false;this.render();};
    this.querySelector('#group').onchange=e=>{this.group=e.target.value;this.targetGroup=this.group;this.periods=[];this.selectedDays.clear();this.dirty=false;this.status='';this.statusType='info';this.loadExistingPrompt=false;this.render();};
    const targetGroup=this.querySelector('#targetGroup');
    if(targetGroup)targetGroup.onchange=e=>{this.targetGroup=e.target.value;this.render();};
    const targetDevice=this.querySelector('#targetDevice');
    if(targetDevice)targetDevice.onchange=e=>{this._targetDevice=e.target.value;this.render();};
    this.querySelector('#existing').onclick=()=>{this.mode='existing';this.resetTarget();this.periods=[];this.loadExistingPrompt=true;this.setStatus(this.t('status_choose_fetch'),'info');this.render();};
    this.querySelector('#new').onclick=()=>this.newSchedule();

    const src=this.querySelector('#source');
    if(src)src.onchange=e=>this.sourceDay=Number(e.target.value);
    const fetch=this.querySelector('#fetch');
    if(fetch)fetch.onclick=()=>this.fetchSchedule();

    this.querySelectorAll('[data-day]').forEach(e=>{e.onclick=x=>this.toggleDay(Number(x.target.dataset.day));});
    this.querySelectorAll('[data-preset]').forEach(e=>{e.onclick=x=>this.setPreset(x.target.dataset.preset);});
    this.querySelector('#clearDays').onclick=()=>this.clearDays();
    this.querySelector('#add').onclick=()=>this.addPeriod();
    this.querySelector('#apply').onclick=()=>this.applySchedule();
    this.querySelectorAll('[data-time]').forEach(e=>{e.onchange=x=>{this.periods[+x.target.dataset.time].minutes=+x.target.value;this.mark();this.render();};});
    this.querySelectorAll('[data-temp]').forEach(e=>{e.onchange=x=>{this.periods[+x.target.dataset.temp].temperature=+x.target.value;this.mark();this.render();};});
    this.querySelectorAll('[data-delete]').forEach(e=>{e.onclick=x=>{this.periods.splice(+x.target.dataset.delete,1);this.mark();this.render();};});
  }
}

if(!customElements.get('sonoff-trv-schedule-panel')){
  customElements.define('sonoff-trv-schedule-panel',SonoffTrvSchedulePanel);
}
