# Phase 12 体验优化报告

测试日期：2026-08-18  
测试设备：Tmall MagicBox_M_30_F，WebView 74，1920×1080 应用画布

## 完成内容

### 轻量音效

使用 Web Audio API 实时合成短音，不引入任何音频文件：

- 选棋
- 落子
- 吃子
- 将军
- 胜利

AudioContext 只在用户第一次操作后创建，关闭音效时会暂停；应用销毁时释放。音效设置保存在本机 WebView `localStorage` 中，完全离线。

### 走子动画

移动棋子使用 150ms 的 `left/top` 短过渡，只更新实际移动的一枚棋子。动画可以在设置面板关闭，并尊重系统 `prefers-reduced-motion`。

### 简明棋谱

每一步自动记录红黑方、手数和象棋记法，例如：

```text
1  車一进一  红
2  卒9进1   黑
```

红方使用中文数字，黑方使用阿拉伯数字；支持进、退、平以及马、象、士的目标线路记法。悔棋会同步删除记录，重新开始会清空记录。面板最多显示最近 16 手，同时保留当前整局记录数量。

### 设置与棋谱面板

主界面新增第五个“设置与棋谱”按钮。面板支持：

- 鼠标点击
- 遥控器方向键切换
- OK 修改或关闭
- BACK 返回对局
- 点击遮罩关闭

音效和动画开关经过关闭、重新打开、覆盖安装及冷启动验证，设置可以保留。

## 真机结果

- 主界面第五个按钮完整显示，没有超出 1080P 安全区域。
- 设置弹层文字、焦点和双栏布局在 WebView 74 上正常。
- 实际完成红黑各一手后，棋谱正确显示“車一进一、卒9进1”。
- Android BACK 只关闭弹层，不退出游戏。
- 近期 Logcat 未发现 WebView JavaScript、AudioContext 或应用崩溃错误。
- 稳定空闲 Total PSS：99747KB，与 Phase 11 基线相当。

电视扬声器的主观响度与音色需要人工听感验收；设置流程和 AudioContext 运行未发现错误。

## 兼容性与包体

针对 Chrome/WebView 74 避免使用不支持的 CSS `min()` 和 `inset` 简写，并使用 margin 代替旧 WebView 不支持的 Flex gap。

- APK：1371037 bytes
- SHA-256：`89d71e5fd939b7939d6a1b71cb5ba30dfac76ea474a6d8b008766cbbc99ab3b9`
- Android 权限：无
- 音频资源：无
- 自动测试：9 个文件，45 项全部通过

## 验证命令

```bash
pnpm --dir web test
./scripts/build-android.sh
./scripts/deploy-debug.sh
```
