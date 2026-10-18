import {expandedSources} from './expanded-source-catalog.mjs';

// Configured provider tenants and the official detail's cross-system ID form
// the link. Titles and opaque IDs from another system are never substituted.
export function officialApplicationUrl(source,externalPostId) {
 if(!source.applicationTenant)return null;
 if(typeof externalPostId==='number'&&!Number.isSafeInteger(externalPostId))throw Error('官方跨系统岗位编号不能丢失整数精度');
 if(!/^[a-z0-9-]+$/.test(source.applicationTenant)||!/^[1-9][0-9]{0,17}$/.test(String(externalPostId??'')))throw Error('官方投递跨系统岗位编号缺失或无效，不能构造替代入口');
 return 'https://www.hotjob.cn/wt/'+source.applicationTenant+'/mobweb/v8/position/detail?recruitType=2&postIdsAry='+externalPostId+'&brandCode=1';
}
export function validOfficialApplicationUrl(sourceId,value) {
 if(typeof value!=='string')return false;
 const source=expandedSources.find(item=>item.id===sourceId);if(!source?.applicationTenant)return false;
 try{return officialApplicationUrl(source,new URL(value).searchParams.get('postIdsAry'))===value;}catch{return false;}
}
