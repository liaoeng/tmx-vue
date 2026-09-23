import type { LoadingInstance } from 'element-plus';
import axiosModule from 'axios';
import errorCode from '@/utils/errorCode';
import { extractErrorMessage, globalHeaders } from '@/utils/request';
import { saveBlob } from '@/utils/save';
import { isNonJsonResponse } from '@/utils/tmx';

const axios = axiosModule as any;
const baseURL = import.meta.env.VITE_APP_BASE_API;
let downloadLoadingInstance: LoadingInstance | undefined;
export default {
  /** 根据文件 ID 从对象存储下载文件。 */
  async oss(ossId: string | number) {
    const url = baseURL + '/resource/oss/download/' + ossId;
    downloadLoadingInstance = ElLoading.service({
      text: '正在下载数据，请稍候',
      background: 'rgba(0, 0, 0, 0.7)'
    });
    try {
      const res = await axios({
        method: 'get',
        url: url,
        responseType: 'blob',
        headers: globalHeaders()
      });
      const isFileResponse = isNonJsonResponse(res.data);
      if (isFileResponse) {
        const blob = new Blob([res.data], { type: 'application/octet-stream' });
        saveBlob(blob, decodeURIComponent(res.headers['download-filename'] as string));
      } else {
        this.printErrMsg(res.data);
      }
      downloadLoadingInstance?.close();
    } catch (r) {
      console.error(r);
      const errMsg = await extractErrorMessage(r);
      ElMessage.error(errMsg || '下载文件出现错误，请联系管理员！');
      downloadLoadingInstance?.close();
    }
  },
  /** 从后端路径下载 ZIP 文件，并按指定文件名保存。 */
  async zip(url: string, name: string) {
    url = baseURL + url;
    downloadLoadingInstance = ElLoading.service({
      text: '正在下载数据，请稍候',
      background: 'rgba(0, 0, 0, 0.7)'
    });
    try {
      const res = await axios({
        method: 'get',
        url: url,
        responseType: 'blob',
        headers: globalHeaders()
      });
      const isFileResponse = isNonJsonResponse(res.data);
      if (isFileResponse) {
        const blob = new Blob([res.data], { type: 'application/zip' });
        saveBlob(blob, name);
      } else {
        this.printErrMsg(res.data);
      }
      downloadLoadingInstance?.close();
    } catch (r) {
      console.error(r);
      const errMsg = await extractErrorMessage(r);
      ElMessage.error(errMsg || '下载文件出现错误，请联系管理员！');
      downloadLoadingInstance?.close();
    }
  },
  /** 下载接口返回 JSON 错误体时，解析并提示后端消息。 */
  async printErrMsg(data: any) {
    const resText = await data.text();
    const rspObj = JSON.parse(resText);
    const errMsg = errorCode[rspObj.code] || rspObj.msg || errorCode['default'];
    ElMessage.error(errMsg);
  }
};
