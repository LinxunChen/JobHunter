// Recruitment channels verified during the 2026-10-09 public-source audit.
// A shared portal's employer/department is preserved; it is never overwritten by the target name.
export const expandedSources = [
  {id:'cbit-social',name:'银保信智联社会招聘专题（主体按岗位核验）',objects:['seed-13','seed-48'],url:'https://webapp.zhaopin.com/2026/bj/zgyhb0422ZL85165/job/index.html',type:'zhaopin',apiOrigin:'https://fe.zhaopin.com',transport:'curl',companyId:'CZ596117920',employer:'中国银行保险信息技术管理有限公司',employers:['中国银行保险信息技术管理有限公司','中国银行保险信息技术管理有限公司北京分公司','中国银行保险信息技术管理有限公司上海分公司','中国银行保险信息技术管理有限公司数据分公司','银保信科技（北京）有限公司']},
  {id:'travelsky-social',name:'中国航信官方社会招聘岗位表',objects:['seed-34'],url:'https://www.travelsky.cn/travelsky/rlzy/rczp/shzp/A069009003002Gone1.html',type:'public-table',transport:'curl',pageIdentity:'中国航信'},
  {id:'unicom-digital-social',name:'联通数字科技国聘社会招聘',objects:['seed-50'],url:'https://ltsk.iguopin.com/',type:'iguopin',apiOrigin:'https://gp-api.iguopin.com',domain:'ltsk',companyId:'10685311791703539',employer:'联通数字科技有限公司'},
  {id:'icbcubs-social',name:'工银瑞信官方社会招聘',objects:['seed-42'],url:'https://icbcubs.hotjob.cn/SU60419b4dbef57c66a923b081/pb/social.html',type:'wecruit',transport:'curl',suite:'SU60419b4dbef57c66a923b081',employer:'工银瑞信基金管理有限公司',redirectTitle:'工银瑞信招聘官网'},
  {id:'tele-research-social',name:'中国电信研究院海外社招专场',objects:['seed-25'],url:'https://campus.51job.com/ct2026/',type:'tele-overseas',transport:'curl',employer:'中国电信研究院'},
  {id:'ctyun-social',name:'天翼云科技官方社会招聘',objects:['seed-51'],url:'https://wecruit.hotjob.cn/SU62b185f42f9d24458d716272/mc/position/society',type:'wecruit',transport:'curl',suite:'SU62b185f42f9d24458d716272',applicationTenant:'ecloud',employer:'天翼云科技有限公司'},
  {id:'citicbank-social',name:'中信银行官方社会招聘',objects:['seed-06'],url:'https://job.citicbank.com/CustStyle/zpmhys/clubRecruit.html',type:'citicbank',transport:'curl',employer:'中信银行'},
  {id:'sinopec-social',name:'中国石化官方未结束社会招聘',objects:['seed-32'],url:'https://job.sinopec.com/',type:'sinopec',transport:'curl'},
  {id:'cib-social',name:'兴业银行官方社会招聘',objects:['seed-09'],url:'https://job.cib.com.cn/portal/',type:'cib',employer:'兴业银行'},
  {id:'abc-social',name:'农业银行官方社会招聘',objects:['seed-03'],url:'https://career.abchina.com.cn/build/index.html',type:'abc',employer:'中国农业银行'},
  {id:'abc-fintech-social',name:'农银金融科技官方社会招聘目录',objects:['seed-45'],url:'https://career.abchina.com.cn/build/index.html',type:'abc',employer:'农银金融科技有限责任公司',orgId:10001183,orgName:'农银金科'},
  {id:'ccbfund-notices',name:'建信基金官方诚聘英才栏目',objects:['seed-43'],url:'https://www.ccbfund.cn/',type:'notices',subtype:'ccbfund',detailPattern:'/resource/static/content/\\d+\\.html',bodyClass:'right-content'},
  {id:'bocom-social',name:'交通银行官方社会招聘',objects:['seed-11'],url:'https://job.bankcomm.com/',type:'bocom',transport:'curl',employer:'交通银行',unitPattern:'^(?:交通银行.*|太平洋信用卡中心)$'},
  {id:'spdb-social',name:'浦发银行官方社会招聘',objects:['seed-10'],url:'https://job.spdb.com.cn/socialJob',type:'spdb'},
  {id:'boc-fintech-notices',name:'中银金融科技官方招聘公告',objects:['seed-47'],url:'https://www.boc.cn/aboutboc/bi4/',type:'notices',subtype:'boc',detailPattern:'/aboutboc/bi4/\\d{6}/t\\d+_\\d+\\.html',bodyClass:'TRS_Editor',titlePattern:'中银金融科技'},
  {id:'nucc-recruitment',name:'网联清算官方招聘',objects:['seed-14'],url:'https://www.nucc.com/',type:'notices',subtype:'json',detailPattern:'/article/\\d+\\.json'},
  {id:'energy-social',name:'国家能源集团社会招聘（主体分别核验）',objects:['seed-30'],url:'https://zhaopin.chnenergy.com.cn/planSerch?kinds=3&searchtype=job',type:'notices',subtype:'energy',detailPattern:'/annc/showgw',queryPattern:'^\\?id=[a-f0-9-]{36}&kinds=3$',bodyClass:'container m20'},
  {id:'bob-social',name:'北京银行',objects:['seed-12'],url:'https://bankofbeijing.zhiye.com/',type:'beisen'},
  {id:'ccdc-social',name:'中央结算公司',objects:['seed-16'],url:'https://ccdc.zhiye.com/',type:'beisen'},
  {id:'life-social',name:'中国人寿官方社招（主体分别核验）',objects:['seed-19'],url:'https://chinalife.zhiye.com/',type:'beisen',unitPattern:'寿险|人寿保险股份'},
  {id:'picc-social',name:'人保财险',objects:['seed-20'],url:'https://picc.zhiye.com/',type:'beisen',unitPattern:'财险|人民财产保险'},
  {id:'chinare-social',name:'中再集团官方社招（主体分别核验）',objects:['seed-22'],url:'https://chinare.zhiye.com/',type:'beisen'},
  {id:'cicc-social',name:'中金公司官方社招（主体分别核验）',objects:['seed-36'],url:'https://cicc.zhiye.com/',type:'beisen',applicationRule:'status-gated-form',apiOrigin:'https://portal-oss.zhiye.com',applicationTemplatePrefix:'/108394/resource/'},
  {id:'csc-social',name:'中信建投证券',objects:['seed-37'],url:'https://csc108.zhiye.com/',type:'beisen'},
  {id:'galaxy-social',name:'中国银河证券',objects:['seed-38'],url:'https://chinastock.zhiye.com/',type:'beisen'},
  {id:'chinaamc-social',name:'华夏基金官方社招（主体分别核验）',objects:['seed-40'],url:'https://chinaamc.zhiye.com/szzw/',type:'classic-beisen'},
  {id:'exim-notices',name:'中国进出口银行官方招聘公告',objects:['seed-27'],url:'http://www.eximbank.gov.cn/info/notice/recruit/',type:'notices',detailPattern:'/info/notice/recruit/\\d{6}/t\\d+_\\d+\\.html',bodyClass:'TRS_Editor'},
  {id:'adbc-notices',name:'中国农业发展银行官方招聘公告',objects:['seed-28'],url:'https://www.adbc.com.cn/n354735/n355043/index.html',type:'notices',detailPattern:'/n354735/n355043/c\\d+/content\\.html',bodyClass:'ContentText'},
  {id:'jiutian-social',name:'中移九天人工智能科技（北京）有限公司',objects:['seed-49'],url:'https://job.10086.cn/personal/job/index.html',type:'cmri',companyId:249,companyShortName:'九天公司',companyType:3,unitPattern:'九天'},
  {id:'jsfund-social',name:'嘉实基金官方社会招聘',objects:['seed-41'],url:'https://app.mokahr.com/social-recruitment/jsfund/44123',type:'moka',orgId:'jsfund',siteId:44123,employer:'嘉实基金管理有限公司',excludedUnitPattern:'嘉实财富|嘉实资本|嘉实国际|财富管理|营销区域|理财工作室'},
  {id:'cebbank-social',name:'光大银行官方社会招聘',objects:['seed-07'],url:'https://eoap.cebbank.com/uiap/wt/CEB/zpzh/social',type:'public-wt',corpCode:'CEB',apiPrefix:'/uiap/wt/CEB/web/json/position/',employer:'中国光大银行',unitPattern:'^(?:中国光大银行.*|.*分行|总行)$'},
  {id:'psbc-notices',name:'邮储银行官方社会招聘栏目',objects:['seed-05'],url:'https://www.psbc.com/cn/gyyc/rczp/shzp/index.html',type:'notices',subtype:'psbc',detailPattern:'/cn/gyyc/rczp/shzp/\\d{6}/t\\d+_\\d+\\.html',bodyClass:'TRS_Editor'},
  {id:'cmb-social',name:'招商银行官方社会招聘',objects:['seed-08'],url:'https://career.cmbchina.com/',type:'cmb',transport:'curl',employer:'招商银行',unitPattern:'^(?:总行.*|.*分行)$'},
  {id:'citics-social',name:'中信证券官方社会招聘',objects:['seed-35'],url:'https://careers.citics.com/',type:'citics',apiOrigin:'https://global-kong.citics.com',employer:'中信证券股份有限公司'},
  {id:'chinaclear-notices',name:'中国结算官方工作机会',objects:['seed-15'],url:'https://m.chinaclear.cn/zdjs/zgzh/about_xxpl.shtml',type:'notices',detailPattern:'/zdjs/zgzh/\\d{6}/[a-f0-9]{32}\\.shtml',bodyClass:'detailContent'},
];
export const expandedMethod = id => 'checkExpanded_'+id.replaceAll('-','_');
export function validExpandedSelection(source,id) {
  if(typeof id!=='string')return false;
  if(source.type==='zhaopin')return new RegExp('^CC'+source.companyId.slice(2)+'J\\d{1,20}$').test(id);
  if(source.type==='public-table')return /^[a-f0-9]{64}$/.test(id);
  if(source.type==='cmri')return /^[A-Za-z0-9_-]{1,128}$/.test(id);
  if(['beisen','moka','cmb','sinopec'].includes(source.type))return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
  if(source.type==='wecruit')return /^[a-f0-9]{24}$/.test(id);
  if(source.type==='public-wt')return /^\d{1,20}$/.test(id);
  if(source.type==='bocom')return /^\d{1,20}$/.test(id);
  if(['abc','cib','citicbank','tele-overseas','iguopin'].includes(source.type))return /^\d{1,20}$/.test(id);
  if(source.type==='citics')return /^(?:Headquarter|Branch):\d{1,20}$/.test(id);
  if(source.type==='spdb')return /^\d{1,20}$/.test(id);
  if(source.type==='classic-beisen')return /^\d{1,20}$/.test(id);
  try {const url=new URL(id);return url.origin===new URL(source.url).origin&&!url.username&&!url.password&&!url.hash&&new RegExp('^'+source.detailPattern+'$').test(url.pathname)&&(source.queryPattern?new RegExp(source.queryPattern).test(url.search):!url.search);}catch{return false;}
}
