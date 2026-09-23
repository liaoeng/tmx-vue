import type { LoadingInstance } from 'element-plus';
import axiosModule from 'axios';
import { HttpStatus } from '@/enums/RespEnum';
import { getLanguage } from '@/lang';
import cache from '@/plugins/cache';
import router from '@/router';
import { useUserStore } from '@/store/modules/user';
import { getToken } from '@/utils/auth';
import { decryptBase64, decryptWithAes, encryptBase64, encryptWithAes, generateAesKey } from '@/utils/crypto';
import { errorCode } from '@/utils/errorCode';
import { decrypt, encrypt } from '@/utils/jsencrypt';
import { saveBlob } from '@/utils/save';
import { isNonJsonResponse, tansParams } from '@/utils/tmx';

/** axios 1.13 + TS6：默认导出在类型上会被解析为不可调用的 export= 形态 */
const axios = axiosModule as any;

const encryptHeader = 'encrypt-key';
const repeatSubmitIntervalMs = 500;
let downloadLoadingInstance: LoadingInstance | undefined;
// 并发请求只显示一个会话过期确认框。
export const isRelogin = { show: false };

/** 标记已向用户展示的业务错误，避免页面层重复弹出相同提示。 */
function createHandledError(message: string) {
  const error = new Error(message) as Error & { isHandled?: boolean };
  error.isHandled = true;
  return error;
}

/** 判断请求错误是否已经由全局响应拦截器提示。 */
export function isHandledRequestError(error: unknown) {
  return Boolean((error as { isHandled?: boolean } | undefined)?.isHandled);
}

/** 将常见网络错误转为可读提示，保留后端未覆盖的原始消息。 */
function normalizeErrorMessage(message?: string) {
  if (!message) {
    return undefined;
  }
  if (message === 'Network Error') {
    return '后端接口连接异常';
  }
  if (message.includes('timeout')) {
    return '系统接口请求超时';
  }
  if (message.includes('Request failed with status code')) {
    return '系统接口' + message.slice(-3) + '异常';
  }
  return message;
}

/** 从普通响应或下载接口返回的 Blob 中提取后端错误消息。 */
async function parseResponseErrorData(data: unknown): Promise<string | undefined> {
  if (!data) {
    return undefined;
  }

  if (data instanceof Blob) {
    return parseResponseErrorData(await data.text());
  }

  if (data instanceof ArrayBuffer) {
    return parseResponseErrorData(new TextDecoder().decode(data));
  }

  if (typeof data === 'string') {
    const text = data.trim();
    if (!text) {
      return undefined;
    }
    try {
      return parseResponseErrorData(JSON.parse(text));
    } catch {
      return text;
    }
  }

  if (typeof data === 'object') {
    const payload = data as Record<string, any>;
    return payload.msg || payload.message || errorCode[payload.code] || errorCode['default'];
  }

  return undefined;
}

/** 优先使用后端消息；没有响应体时再解释网络或超时错误。 */
export async function extractErrorMessage(error: any): Promise<string | undefined> {
  const responseMessage = await parseResponseErrorData(error?.response?.data);
  if (responseMessage) {
    return responseMessage;
  }
  return normalizeErrorMessage(error?.message);
}

/** 供不经过 service 拦截器的下载请求显式携带认证与客户端标识。 */
export const globalHeaders = () => {
  return {
    Authorization: 'Bearer ' + getToken(),
    clientid: import.meta.env.VITE_APP_CLIENT_ID
  };
};

axios.defaults.headers['Content-Type'] = 'application/json;charset=utf-8';
axios.defaults.headers['clientid'] = import.meta.env.VITE_APP_CLIENT_ID;
// 创建 axios 实例
const service = axios.create({
  baseURL: import.meta.env.VITE_APP_BASE_API,
  timeout: 50000,
  transitional: {
    // 超时错误更明确
    clarifyTimeoutError: true
  }
});

// 请求拦截器
service.interceptors.request.use(
  (config: any) => {
    // 对应国际化资源文件后缀
    config.headers['Content-Language'] = getLanguage();

    // 这些请求头是接口级开关：false 表示跳过默认认证或重复提交保护。
    const skipToken = config.headers?.isToken === false;
    const skipRepeatSubmit = config.headers?.repeatSubmit === false;
    const encryptRequest = config.headers?.isEncrypt === 'true';

    if (getToken() && !skipToken) {
      config.headers['Authorization'] = 'Bearer ' + getToken();
    }
    // 将 GET 参数写入 URL，并清空 params 以避免 axios 再次追加。
    if (config.method === 'get' && config.params) {
      let url = config.url + '?' + tansParams(config.params);
      url = url.slice(0, -1);
      config.params = {};
      config.url = url;
    }

    if (!skipRepeatSubmit && (config.method === 'post' || config.method === 'put')) {
      const requestObj = {
        url: config.url,
        data: typeof config.data === 'object' ? JSON.stringify(config.data) : config.data,
        time: new Date().getTime()
      };
      const sessionObj = cache.session.getJSON('sessionObj');
      if (sessionObj === undefined || sessionObj === null || sessionObj === '') {
        cache.session.setJSON('sessionObj', requestObj);
      } else {
        // 仅拦截同一地址、同一请求体且间隔不足 500ms 的重复提交。
        const sameRequest = sessionObj.url === requestObj.url && sessionObj.data === requestObj.data;
        if (sameRequest && requestObj.time - sessionObj.time < repeatSubmitIntervalMs) {
          const message = '数据正在处理，请勿重复提交';
          console.warn(`[${sessionObj.url}]: ` + message);
          return Promise.reject(new Error(message));
        } else {
          cache.session.setJSON('sessionObj', requestObj);
        }
      }
    }
    if (import.meta.env.VITE_APP_ENCRYPT === 'true') {
      // 当开启参数加密
      if (encryptRequest && (config.method === 'post' || config.method === 'put')) {
        // 生成一个 AES 密钥
        const aesKey = generateAesKey();
        config.headers[encryptHeader] = encrypt(encryptBase64(aesKey));
        config.data =
          typeof config.data === 'object'
            ? encryptWithAes(JSON.stringify(config.data), aesKey)
            : encryptWithAes(config.data, aesKey);
      }
    }
    // 让浏览器为 FormData 自动生成包含 boundary 的 Content-Type。
    if (config.data instanceof FormData) {
      delete config.headers['Content-Type'];
    }
    return config;
  },
  (error: any) => {
    return Promise.reject(error);
  }
);

// 响应拦截器
service.interceptors.response.use(
  (res: any) => {
    if (import.meta.env.VITE_APP_ENCRYPT === 'true') {
      // 后端使用前端公钥加密本次响应的 AES 密钥，浏览器据此解密响应体。
      const keyStr = res.headers[encryptHeader];
      if (keyStr != null && keyStr != '') {
        const data = res.data;
        // 响应体 AES 解密。
        const base64Str = decrypt(keyStr);
        // base64 解码 得到请求头的 AES 秘钥
        const aesKey = decryptBase64(base64Str.toString());
        // aesKey 解码 data
        const decryptData = decryptWithAes(data, aesKey);
        // 将结果 (得到的是 JSON 字符串) 转为 JSON
        res.data = JSON.parse(decryptData);
      }
    }
    // 未设置状态码则默认成功状态
    const code = res.data.code || HttpStatus.SUCCESS;
    // 获取错误信息
    const msg = res.data.msg || errorCode[code] || errorCode['default'];
    // 二进制数据则直接返回
    if (res.request.responseType === 'blob' || res.request.responseType === 'arraybuffer') {
      return res.data;
    }
    if (code === 401) {
      if (!isRelogin.show) {
        isRelogin.show = true;
        ElMessageBox.confirm('登录状态已过期，您可以继续留在该页面，或者重新登录', '系统提示', {
          confirmButtonText: '重新登录',
          cancelButtonText: '取消',
          type: 'warning'
        })
          .then(() => {
            isRelogin.show = false;
            useUserStore()
              .logout()
              .then(() => {
                router.replace({
                  path: '/login',
                  query: {
                    redirect: encodeURIComponent(router.currentRoute.value.fullPath || '/')
                  }
                });
              });
          })
          .catch(() => {
            isRelogin.show = false;
          });
      }
      return Promise.reject('无效的会话，或者会话已过期，请重新登录。');
    } else if (code === HttpStatus.SERVER_ERROR) {
      ElMessage({ message: msg, type: 'error' });
      return Promise.reject(createHandledError(msg));
    } else if (code === HttpStatus.WARN) {
      ElMessage({ message: msg, type: 'warning' });
      return Promise.reject(createHandledError(msg));
    } else if (code !== HttpStatus.SUCCESS) {
      ElNotification.error({ title: msg });
      return Promise.reject(createHandledError(msg));
    } else {
      return Promise.resolve(res.data);
    }
  },
  async (error: any) => {
    const message = (await extractErrorMessage(error)) || errorCode['default'];
    ElMessage({ message: message, type: 'error', duration: 5 * 1000 });
    error.isHandled = true;
    return Promise.reject(error);
  }
);
/** 下载表单导出文件；后端若返回错误 JSON，则显示错误而不保存文件。 */
export function download(url: string, params: any, fileName: string) {
  downloadLoadingInstance = ElLoading.service({
    text: '正在下载数据，请稍候',
    background: 'rgba(0, 0, 0, 0.7)'
  });
  return service
    .post(url, params, {
      transformRequest: [
        (params: any) => {
          return tansParams(params);
        }
      ],
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      responseType: 'blob'
    })
    .then(async (resp: any) => {
      const isFileResponse = isNonJsonResponse(resp);
      if (isFileResponse) {
        const blob = new Blob([resp]);
        saveBlob(blob, fileName);
      } else {
        const blob = new Blob([resp]);
        const resText = await blob.text();
        const rspObj = JSON.parse(resText);
        const errMsg = errorCode[rspObj.code] || rspObj.msg || errorCode['default'];
        ElMessage.error(errMsg);
      }
      downloadLoadingInstance?.close();
    })
    .catch((r: any) => {
      console.error(r);
      downloadLoadingInstance?.close();
    });
}
// 导出 axios 实例
export default service;
