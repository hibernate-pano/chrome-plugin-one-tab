// P0：测试命令经 --import 全局预装本模块，确保所有测试文件（含静态导入 src 的）
// 都走 _alias-loader（@/ 别名 + 无扩展名解析 + import.meta.env stub），
// 新增 src 间导入不再逐个修测试文件。
import { register } from 'node:module';

register(new URL('./_alias-loader.mjs', import.meta.url));
