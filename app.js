/* ==========================================================================
   THE MAN CAVE — App Logic
   ESPN + NWS + NIFC/ArcGIS + Geolocation + Nominatim
   ========================================================================== */

// ---- Configuration ----
const FAV_IDS = new Set([12, 21, 9]);
const FAV_NAMES = { 12:'LA Clippers', 21:'Phoenix Suns', 9:'Golden State Warriors' };
const DEFAULT_LAT = 35.1894, DEFAULT_LON = -114.0530, DEFAULT_CITY = 'Kingman, AZ';
const REFRESH_MS = 120000;

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const SPORT_EP = {
  nba:   ESPN_BASE + '/basketball/nba/scoreboard',
  ncaab: ESPN_BASE + '/basketball/mens-college-basketball/scoreboard',
  mlb:   ESPN_BASE + '/baseball/mlb/scoreboard',
  cbase: ESPN_BASE + '/baseball/college-baseball/scoreboard',
  nfl:   ESPN_BASE + '/football/nfl/scoreboard',
  cfb:   ESPN_BASE + '/football/college-football/scoreboard',
};
const NBA_NEWS_EP = ESPN_BASE + '/basketball/nba/news?limit=15';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const NWS_PTS = 'https://api.weather.gov/points';
const FIRE_EP = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query';

// ---- State ----
let userLat = DEFAULT_LAT, userLon = DEFAULT_LON, userCity = DEFAULT_CITY;
let nwsForecastUrl = null, nwsHourlyUrl = null;
let refreshTimer = null, cdTimer = null, cdVal = 120;
let nbaCache = null;

// ---- DOM ----
const $ = (id) => document.getElementById(id);

// ---- Helpers ----
function timeAgo(d) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}
function fmtDate(d) {
  return d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
}
function wxIcon(f) {
  const s = (f||'').toLowerCase();
  if (s.includes('thunder')||s.includes('tstorm')) return '⛈️';
  if (s.includes('rain')||s.includes('shower')||s.includes('drizzle')) return '🌧️';
  if (s.includes('snow')||s.includes('blizzard')||s.includes('flurr')) return '🌨️';
  if (s.includes('fog')||s.includes('mist')||s.includes('haze')) return '🌫️';
  if (s.includes('cloud')||s.includes('overcast')) return s.includes('partly')?'⛅':'☁️';
  if (s.includes('wind')) return '💨';
  if (s.includes('hot')||s.includes('heat')) return '🔥';
  if (s.includes('clear')||s.includes('sunny')||s.includes('fair')) return s.includes('night')?'🌙':'☀️';
  return '🌤️';
}
function haversine(la1,lo1,la2,lo2) {
  const R=3959,dLa=(la2-la1)*Math.PI/180,dLo=(lo2-lo1)*Math.PI/180;
  const a=Math.sin(dLa/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLo/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function errHTML(ic,msg,sub){return '<div class="err-card"><div class="e-i">'+ic+'</div><div class="e-m">'+msg+'</div>'+(sub?'<div class="e-r">'+sub+'</div>':'')+'</div>';}
function emptyHTML(ic,t,s){return '<div class="empty-card"><div class="em-i">'+ic+'</div><div class="em-t">'+t+'</div>'+(s?'<div class="em-s">'+s+'</div>':'')+'</div>';}
function splashPct(p){ $('spFill').style.width = p+'%'; }

async function fetchJ(url,ms){
  const c=new AbortController();const t=setTimeout(()=>c.abort(),ms||10000);
  try{const r=await fetch(url,{signal:c.signal});if(!r.ok)throw new Error(r.status);return await r.json();}
  finally{clearTimeout(t);}
}

// ===========================================================================
// TAB NAVIGATION
// ===========================================================================
function switchTab(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  $('page-'+name).classList.add('active');
  if(btn)btn.classList.add('active');
  $('contentArea').scrollTop=0;
}
function subTab(page,sub,btn) {
  var par=$('page-'+page);
  par.querySelectorAll('[id^="'+page+'-"]').forEach(s=>s.style.display='none');
  par.querySelectorAll('.s-tab').forEach(t=>t.classList.remove('active'));
  $(page+'-'+sub).style.display='block';
  if(btn)btn.classList.add('active');
}

// ===========================================================================
// GEOLOCATION
// ===========================================================================
async function initLocation() {
  var dot=$('locDot'), txt=$('locText');
  dot.className='loc-dot wait'; txt.textContent='Detecting your location…';
  if(!navigator.geolocation){
    dot.className='loc-dot err'; txt.textContent='Using default: '+DEFAULT_CITY;
    await resolveNWS(DEFAULT_LAT,DEFAULT_LON); return;
  }
  try {
    var pos = await new Promise(function(ok,fail){
      navigator.geolocation.getCurrentPosition(ok,fail,{timeout:8000,enableHighAccuracy:false});
    });
    userLat=pos.coords.latitude; userLon=pos.coords.longitude;
    try {
      var rev=await fetchJ(NOMINATIM_BASE+'/reverse?format=json&lat='+userLat+'&lon='+userLon,6000);
      var ad=rev.address||{};
      userCity=(ad.city||ad.town||ad.village||ad.county||'Your Location')+(ad.state?', '+ad.state:'');
    } catch(e){ userCity=userLat.toFixed(2)+'\u00b0, '+userLon.toFixed(2)+'\u00b0'; }
    dot.className='loc-dot ok'; txt.textContent=userCity;
    await resolveNWS(userLat,userLon);
  } catch(e) {
    dot.className='loc-dot err'; txt.textContent='Location denied \u00b7 Using '+DEFAULT_CITY;
    userLat=DEFAULT_LAT; userLon=DEFAULT_LON; userCity=DEFAULT_CITY;
    await resolveNWS(DEFAULT_LAT,DEFAULT_LON);
  }
}
async function resolveNWS(lat,lon) {
  try {
    var d=await fetchJ(NWS_PTS+'/'+lat.toFixed(4)+','+lon.toFixed(4));
    nwsForecastUrl=d.properties.forecast; nwsHourlyUrl=d.properties.forecastHourly;
  } catch(e){ nwsForecastUrl=null; }
}

// ===========================================================================
// WEATHER SEARCH
// ===========================================================================
async function searchWeather() {
  var inp=$('wInput'), q=inp.value.trim(); if(!q)return;
  var btn=$('wBtn'); btn.textContent='\u2026'; btn.disabled=true;
  try {
    var geo=await fetchJ(NOMINATIM_BASE+'/search?q='+encodeURIComponent(q)+'&format=json&limit=1',8000);
    if(!geo.length) throw new Error('nope');
    userLat=parseFloat(geo[0].lat); userLon=parseFloat(geo[0].lon);
    userCity=geo[0].display_name.split(',').slice(0,2).join(',').trim();
    $('locDot').className='loc-dot ok'; $('locText').textContent=userCity;
    await resolveNWS(userLat,userLon);
    await Promise.all([loadWeather(), loadFire()]);
    inp.value='';
  } catch(e) {
    $('weatherCard').innerHTML=errHTML('—','Couldn\'t find "'+q+'"','Try a city name like "Phoenix, AZ"');
  } finally { btn.textContent='Go'; btn.disabled=false; }
}

// ===========================================================================
// WEATHER
// ===========================================================================
async function loadWeather() {
  try {
    if(!nwsForecastUrl) throw new Error('No NWS');
    var fc=await fetchJ(nwsForecastUrl);
    var pp=fc.properties.periods; if(!pp||!pp.length)throw new Error('empty');
    var n=pp[0], temp=n.temperature, unit=n.temperatureUnit||'F';
    var cond=n.shortForecast, wind=n.windSpeed+' '+n.windDirection;
    var hum=n.relativeHumidity?n.relativeHumidity.value+'%':'\u2014';

    $('weatherCard').innerHTML='<div class="weather-card">'
      +'<div class="w-loc">Weather for '+userCity+'</div>'
      +'<div class="w-main"><div class="w-left"><div class="w-icon">'+wxIcon(cond)+'</div>'
      +'<div><div class="w-temp">'+temp+'<span class="w-deg">\u00b0'+unit+'</span></div></div></div>'
      +'<div class="w-right"><div class="w-cond">'+cond+'</div>'
      +'<div class="w-detail">Wind: '+wind+'<br>Humidity: '+hum+'</div></div></div></div>';

    // Forecast carousel
    var fh='<div class="forecast-scroll">';
    for(var i=0;i<pp.length&&i<14;i++){
      var p=pp[i];
      if(p.isDaytime){
        var night=pp[i+1], lo=night?night.temperature:'\u2014';
        var dl=p.name.length>8?p.name.substring(0,6)+'\u2026':p.name;
        fh+='<div class="fc-item"><div class="fc-day">'+dl+'</div>'
          +'<div class="fc-icon">'+wxIcon(p.shortForecast)+'</div>'
          +'<div class="fc-temp">'+p.temperature+'\u00b0</div>'
          +'<div class="fc-lo">'+lo+'\u00b0</div></div>';
      }
    }
    fh+='</div>';
    $('forecastSection').innerHTML=fh;

    // Extended forecast for alerts page
    var eh='';
    pp.forEach(function(p,i){
      if(i>9)return;
      eh+='<div class="ext-fc" data-i="'+i+'">'
        +'<div class="ext-hdr"><span class="ext-icon">'+wxIcon(p.shortForecast)+'</span>'
        +'<span class="ext-day">'+p.name+'</span>'
        +'<span class="ext-temp">'+p.temperature+'\u00b0'+p.temperatureUnit+'</span></div>'
        +'<div class="ext-body">'+p.detailedForecast+'</div></div>';
    });
    $('extForecast').innerHTML=eh||emptyHTML('—','No forecast data');
  } catch(e) {
    $('weatherCard').innerHTML=errHTML('—',
      nwsForecastUrl?'Weather temporarily unavailable':'NWS only covers US locations',
      'Will retry on next refresh');
    $('forecastSection').innerHTML='';
    $('extForecast').innerHTML=errHTML('—','Forecast unavailable','Try searching a US city');
  }
}

// ===========================================================================
// FIRE WATCH
// ===========================================================================
async function loadFire() {
  var rng=4;
  var bbox=JSON.stringify({xmin:userLon-rng,ymin:userLat-rng,xmax:userLon+rng,ymax:userLat+rng});
  try {
    var url=FIRE_EP+'?where=1%3D1&outFields=IncidentName,IncidentSize,PercentContained,POOLatitude,POOLongitude,IncidentTypeCategory,FireDiscoveryDateTime,DailyAcres'
      +'&geometry='+encodeURIComponent(bbox)+'&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&f=json&resultRecordCount=50';
    var data=await fetchJ(url,12000);
    var fires=(data.features||[]).map(function(f){
      var a=f.attributes, lat=a.POOLatitude||(f.geometry&&f.geometry.y), lon=a.POOLongitude||(f.geometry&&f.geometry.x);
      var dist=(lat&&lon)?haversine(userLat,userLon,lat,lon):9999;
      return Object.assign({},a,{dist:dist});
    }).filter(function(f){return f.IncidentName&&f.dist<300;})
      .sort(function(a,b){return a.dist-b.dist;}).slice(0,10);

    if(!fires.length){
      var safe='<div class="fire-safe"><div class="fire-safe-i"><svg viewBox="0 0 24 24" width="40" height="40"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke="#22c55e" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>'
        +'<div class="fire-safe-t">All Clear</div>'
        +'<div class="fire-safe-s">No active wildfires within 300 miles</div></div>';
      $('fireCard').innerHTML=safe; $('alertsFire').innerHTML=safe;
    } else {
      var h='';
      fires.forEach(function(f,i){
        var ac=f.DailyAcres||f.IncidentSize||0;
        var pct=f.PercentContained!=null?f.PercentContained+'%':'N/A';
        var disc=f.FireDiscoveryDateTime?new Date(f.FireDiscoveryDateTime).toLocaleDateString():'';
        h+='<div class="fire-card" data-i="'+i+'">'
          +'<div class="fire-hdr"><span class="fire-dot"></span><span class="fire-nm">'+f.IncidentName+'</span>'
          +'<span class="fire-dist">'+f.dist.toFixed(0)+' mi away</span></div>'
          +'<div class="fire-stats"><span class="fire-stat"><strong>'+(ac?ac.toLocaleString():'\u2014')+'</strong> acres</span>'
          +'<span class="fire-stat"><strong>'+pct+'</strong> contained</span>'
          +(disc?'<span class="fire-stat">Started '+disc+'</span>':'')
          +'</div></div>';
      });
      $('fireCard').innerHTML=h; $('alertsFire').innerHTML=h;
    }
  } catch(e) {
    var fb=errHTML('—','Fire data temporarily unavailable','Will retry shortly');
    $('fireCard').innerHTML=fb; $('alertsFire').innerHTML=fb;
  }
}

// ===========================================================================
// ESPN SCOREBOARD
// ===========================================================================
function gameHTML(game,i,sport) {
  var c=game.competitions&&game.competitions[0]; if(!c)return '';
  var teams=c.competitors||[];
  var home=teams.find(function(t){return t.homeAway==='home';})||teams[0];
  var away=teams.find(function(t){return t.homeAway==='away';})||teams[1];
  if(!home||!away)return '';

  var st=game.status&&game.status.type;
  var isLive=st&&st.state==='in', isFinal=st&&st.state==='post', isPre=st&&st.state==='pre';
  var stTxt=(st&&(st.shortDetail||st.detail))||'';
  var isFav=sport==='nba'&&(FAV_IDS.has(Number(home.team&&home.team.id))||FAV_IDS.has(Number(away.team&&away.team.id)));

  var cls='game-card';
  if(isLive)cls+=' live-game';
  if(isFav)cls+=' fav-game';

  var hW=false,aW=false;
  if(isFinal){hW=Number(home.score)>Number(away.score);aW=Number(away.score)>Number(home.score);}

  var bc=c.broadcasts?c.broadcasts.flatMap(function(b){return b.names||[];}):[];
  var bcT=bc.slice(0,2).join(', ');

  function tRow(t,win,lose){
    var logo=(t.team&&t.team.logo)||'';
    var nm=(t.team&&(t.team.shortDisplayName||t.team.displayName||t.team.name))||'?';
    var rec=(t.records&&t.records[0]&&t.records[0].summary)||'';
    var sc=(isLive||isFinal)?(t.score||'0'):'';
    var rc='t-row'; if(win)rc+=' winner'; if(lose)rc+=' loser';
    return '<div class="'+rc+'">'
      +(logo?'<img class="t-logo" src="'+logo+'" alt="" loading="lazy" onerror="this.style.display=\'none\'">':'<div class="t-logo"></div>')
      +'<span class="t-name">'+nm+(rec?'<span class="t-rec">('+rec+')</span>':'')+'</span>'
      +'<span class="t-score">'+sc+'</span></div>';
  }

  var sHTML='';
  if(isLive){
    sHTML='<span class="g-status live"><span class="live-dot"></span><span class="live-badge">LIVE</span> '+stTxt+'</span>';
  } else {
    sHTML='<span class="g-status">'+stTxt+'</span>';
  }

  return '<div class="'+cls+'" data-i="'+(i%10)+'">'
    +'<div class="g-sbar">'+sHTML+(bcT?'<span class="g-bc">'+bcT+'</span>':'')+'</div>'
    +tRow(away,aW,hW&&isFinal)+tRow(home,hW,aW&&isFinal)+'</div>';
}

async function loadBoard(sport,boardId,countId) {
  try {
    var data=await fetchJ(SPORT_EP[sport]);
    var ev=data.events||[];
    if(sport==='nba')nbaCache=data;
    var cel=$(countId); if(cel)cel.textContent=ev.length;
    if(!ev.length){
      var si=data.leagues&&data.leagues[0]&&data.leagues[0].season;
      $(boardId).innerHTML=emptyHTML('—','No games scheduled today',
        si?'Season: '+(si.displayName||si.year):'Check back on game days');
      return;
    }
    $(boardId).innerHTML=ev.map(function(g,i){return gameHTML(g,i,sport);}).join('');
  } catch(e) {
    $(boardId).innerHTML=errHTML('—','Scores temporarily unavailable','Will retry on next refresh');
    var cel2=$(countId); if(cel2)cel2.textContent='\u2014';
  }
}

// ===========================================================================
// FAVORITE TEAMS
// ===========================================================================
async function loadFavs() {
  try {
    if(!nbaCache){
      try{nbaCache=await fetchJ(SPORT_EP.nba);}catch(e){nbaCache={events:[]};}
    }
    var ev=nbaCache.events||[];
    var html='';
    var ids=Object.keys(FAV_NAMES);
    ids.forEach(function(idStr,idx){
      var id=Number(idStr), info=FAV_NAMES[idStr];
      var game=ev.find(function(e){
        var cs=e.competitions&&e.competitions[0]&&e.competitions[0].competitors;
        return cs&&cs.some(function(c){return Number(c.team&&c.team.id)===id;});
      });

      var body='',logo='',record='';
      if(game){
        var c=game.competitions[0], ts=c.competitors||[];
        var my=ts.find(function(t){return Number(t.team&&t.team.id)===id;});
        var opp=ts.find(function(t){return Number(t.team&&t.team.id)!==id;});
        logo=(my&&my.team&&my.team.logo)||'';
        record=(my&&my.records&&my.records[0]&&my.records[0].summary)||'';
        var st=game.status&&game.status.type;
        var isLive=st&&st.state==='in', isFinal=st&&st.state==='post';
        var stTxt=(st&&(st.shortDetail||st.detail))||'';
        var oppNm=(opp&&opp.team&&(opp.team.shortDisplayName||opp.team.name))||'?';
        var isHome=my&&my.homeAway==='home';
        var pfx=isHome?'vs':'@';

        if(isLive){
          body='<div><span class="live-badge" style="display:inline-block;margin-bottom:4px">LIVE</span> '+stTxt+'</div>'
            +'<div class="score-line">'+info.split(' ').pop()+' '+my.score+' - '+opp.score+' '+oppNm+'</div>';
        } else if(isFinal){
          var won=Number(my.score)>Number(opp.score);
          body='<div>'+stTxt+'</div><div class="score-line '+(won?'win':'loss')+'">'
            +(won?'W':'L')+' '+my.score+' - '+opp.score+' '+pfx+' '+oppNm+'</div>';
        } else {
          body='<div>Next Game</div><div class="score-line">'+pfx+' '+oppNm+'</div><div>'+stTxt+'</div>';
        }
      } else {
        body='<div>No game today</div><div style="font-size:12px;color:var(--t3);margin-top:4px">Check the Hoops tab for full schedule</div>';
      }

      html+='<div class="fav-card" data-team="'+id+'" data-i="'+idx+'">'
        +'<div class="fav-hdr">'
        +(logo?'<img class="fav-logo" src="'+logo+'" alt="'+info+'" loading="lazy" onerror="this.style.display=\'none\'">':'')
        +'<div class="fav-info"><div class="fav-name">'+info+'</div>'
        +(record?'<div class="fav-rec">'+record+'</div>':'')
        +'</div></div><div class="fav-body">'+body+'</div></div>';
    });
    $('favTeams').innerHTML=html||emptyHTML('—','No team data available');
  } catch(e) {
    $('favTeams').innerHTML=errHTML('—','Team updates unavailable','Will retry shortly');
  }
}

// ===========================================================================
// NBA NEWS
// ===========================================================================
async function loadNews() {
  try {
    var data=await fetchJ(NBA_NEWS_EP);
    var arts=data.articles||[];
    if(!arts.length){$('homeNews').innerHTML=emptyHTML('—','No headlines right now');return;}
    var h='';
    arts.slice(0,8).forEach(function(a,i){
      var img=(a.images&&a.images[0]&&a.images[0].url)||'';
      var link=(a.links&&a.links.web&&a.links.web.href)||'#';
      var tm=a.published?timeAgo(a.published):'';
      var src=a.source||'ESPN';
      h+='<a class="news-card" href="'+link+'" target="_blank" rel="noopener" data-i="'+i+'">'
        +(img?'<img class="news-img" src="'+img+'" alt="" loading="lazy" onerror="this.style.display=\'none\'">':'')
        +'<div class="news-body"><div class="news-hl">'+(a.headline||a.title||'')+'</div>'
        +'<div class="news-meta">'+src+' \u00b7 '+tm+'</div></div></a>';
    });
    $('homeNews').innerHTML=h;
  } catch(e) {
    $('homeNews').innerHTML=errHTML('—','Headlines unavailable','Will retry shortly');
  }
}

// ===========================================================================
// REFRESH ENGINE
// ===========================================================================
async function refreshAll() {
  var btn=$('refreshBtn'); btn.classList.add('spinning');
  cdVal=120;

  await Promise.allSettled([
    loadWeather(), loadFire(),
    loadBoard('nba','nbaBoard','nbaCt'),
    loadBoard('ncaab','ncaabBoard','ncaabCt'),
    loadBoard('mlb','mlbBoard','mlbCt'),
    loadBoard('cbase','cbaseBoard','cbaseCt'),
    loadBoard('nfl','nflBoard','nflCt'),
    loadBoard('cfb','cfbBoard','cfbCt'),
    loadNews()
  ]);
  await loadFavs();

  btn.classList.remove('spinning');
  var now=new Date();
  $('lastUpd').innerHTML='Updated '+now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})
    +' \u00b7 <span class="countdown" id="cd">2:00</span>';
  $('hdrSub').textContent=userCity+' \u00b7 '+fmtDate(now);

  clearInterval(refreshTimer); clearInterval(cdTimer);
  cdVal=120;
  cdTimer=setInterval(function(){
    cdVal--;
    var el=$('cd');
    if(el)el.textContent=Math.floor(cdVal/60)+':'+String(cdVal%60).padStart(2,'0');
    if(cdVal<=0)clearInterval(cdTimer);
  },1000);
  refreshTimer=setTimeout(refreshAll,REFRESH_MS);
}

// ===========================================================================
// BOOT
// ===========================================================================
async function boot() {
  splashPct(10);
  await initLocation();
  splashPct(30);

  await Promise.allSettled([
    loadWeather().then(function(){splashPct(50);}),
    loadFire().then(function(){splashPct(55);}),
    loadBoard('nba','nbaBoard','nbaCt').then(function(){splashPct(65);}),
    loadBoard('ncaab','ncaabBoard','ncaabCt'),
    loadBoard('mlb','mlbBoard','mlbCt').then(function(){splashPct(75);}),
    loadBoard('cbase','cbaseBoard','cbaseCt'),
    loadBoard('nfl','nflBoard','nflCt').then(function(){splashPct(85);}),
    loadBoard('cfb','cfbBoard','cfbCt'),
    loadNews().then(function(){splashPct(90);})
  ]);
  await loadFavs();
  splashPct(100);

  var now=new Date();
  $('hdrSub').textContent=userCity+' \u00b7 '+fmtDate(now);
  $('lastUpd').innerHTML='Updated '+now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})
    +' \u00b7 <span class="countdown" id="cd">2:00</span>';

  // Dismiss splash
  setTimeout(function(){
    $('splash').classList.add('bye');
    $('app').style.opacity='1';
    setTimeout(function(){$('splash').remove();},700);
  },400);

  // Start auto-refresh
  cdVal=120;
  cdTimer=setInterval(function(){
    cdVal--;
    var el=$('cd');
    if(el)el.textContent=Math.floor(cdVal/60)+':'+String(cdVal%60).padStart(2,'0');
    if(cdVal<=0)clearInterval(cdTimer);
  },1000);
  refreshTimer=setTimeout(refreshAll,REFRESH_MS);
}

// Service Worker Registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(function(){});
}

// Enter key for weather search
document.addEventListener('DOMContentLoaded',function(){
  $('wInput').addEventListener('keydown',function(e){if(e.key==='Enter')searchWeather();});
  boot();
});
