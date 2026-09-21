import {z} from 'zod';

// 镜像 Urmotiv packages/contracts/src/robot.ts；管理日志只含白名单投影。
export const fermataLogsSchema=z.object({
  startedAt:z.string().datetime(),
  items:z.array(z.object({id:z.number().int().positive(),time:z.string().datetime(),level:z.enum(['INFO','WARN','ERROR']),message:z.string().max(200),errorCode:z.string().max(100).nullable(),details:z.record(z.string(),z.union([z.number(),z.boolean()]))}).strict()).max(200)
}).strict();
const messages=new Set([
  'Fermata 启动完成','开始处理审题任务','完成审题任务','处理审题任务失败','领取任务失败',
  '机器人令牌认证失败，请检查 URMOTIV_ROBOT_TOKEN 是否有效','当前审题模型缺少服务商密钥，跳过这一轮轮询','机器人凭据尚未配置，跳过这一轮轮询',
  '提交审核意见时机器人令牌认证失败','轮询过程出现未捕获异常','没有权限处理这个任务，放弃且不重试',
  '任务已经不属于我们（租约过期或版本变化），放弃且不重试','收到停机信号，开始优雅停机','停机完成',
  '管理端口处理请求时出现未捕获异常','运行期 experimentVersion 与当前配置不一致，拒绝领取任务；请由操作员核对后明确更新设置',
  '当前设置的 modelProfileName 在 config/models.yaml 里不存在，跳过这一轮轮询',
  '续租时出现未捕获异常','续租暂未完成，将在安全租约预算内复用同一请求标识重试',
  '续租失败：机器人令牌认证失败，停止当前任务','续租失败：没有继续处理这个任务的权限，标记放弃',
  '模型深度审阅开始','模型深度审阅完成','结构化意见整理开始','结构化意见整理完成'
]);
const startedAt=new Date().toISOString();
const safeCodes=new Set(['CONFIG_INVALID','LLM_HTTP_ERROR','LLM_NETWORK_FAILED','LLM_FIRST_OUTPUT_TIMEOUT','LLM_OUTPUT_IDLE_TIMEOUT','LLM_TOTAL_TIMEOUT','LLM_STREAM_INTERRUPTED','LLM_CANCELLED','LLM_OUTPUT_LENGTH_LIMIT','LLM_OUTPUT_CONTENT_FILTERED','LLM_RETAINED_TEXT_TOO_LARGE','LLM_RESPONSE_FORMAT_INVALID','LLM_JSON_OUTPUT_INVALID','PARSE_ERROR','VALIDATION_ERROR','REQUEST_ABORTED','UNEXPECTED_ERROR']);
const entries:z.infer<typeof fermataLogsSchema>['items']=[];let sequence=0;
export function recordRuntimeLog(level:string,message:string,fields:Readonly<Record<string,unknown>>={}){
  const details:Record<string,number|boolean>={};
  for(const name of ['count','revision','elapsedMs','statusCode','activeTasks','secretsConfigured']){
    const value=fields[name];if(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))details[name]=value;
  }
  const errorCode=typeof fields.errorCode==='string'?(safeCodes.has(fields.errorCode)?fields.errorCode:'UNEXPECTED_ERROR'):null;
  entries.push({id:++sequence,time:new Date().toISOString(),level:level==='ERROR'?'ERROR':level==='WARN'?'WARN':'INFO',message:messages.has(message)?message:'服务运行事件',errorCode,details});
  if(entries.length>1000)entries.splice(0,entries.length-1000);
}
export function runtimeLogs(level='all',limit=100){
  return fermataLogsSchema.parse({startedAt,items:entries.filter(item=>level==='all'||item.level===level).slice(-limit).reverse()});
}
