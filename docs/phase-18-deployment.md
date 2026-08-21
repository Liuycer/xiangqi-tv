# Phase 18 分析功能部署验收报告

测试设备：Tmall MagicBox_M_30_F，WebView 74
服务端：阿里云 2C2G，公网地址 `112.74.108.214`
引擎：Pikafish，Threads=2，Hash=128MB，单引擎并发锁

## 部署一致性

| 项目 | 结果 |
| --- | --- |
| 本地与 VPS `main.py` SHA-256 | `dbdb310f0ce0c43105eeac886d1d6121f4fcbd506478cedb1c55d0d053ecad7e`，一致 |
| `xiangqi-engine-api` | active |
| Nginx | active |
| MultiPV 1 | 1 路候选，1001ms，D19，460113 节点 |
| MultiPV 3 | 3 路候选，数量与排名正确 |

## 三档分析性能

初始局面、MultiPV=3 的一轮实测：

| 档位 | 预算 | 实际耗时 | 深度 | 节点数 |
| --- | ---: | ---: | ---: | ---: |
| 快速 | 1500ms | 1502ms | D17 | 737321 |
| 标准 | 3000ms | 3001ms | D19 | 2115236 |
| 深入 | 5000ms | 5002ms | D19 | 2704346 |

另一轮 5 秒资源采样达到 D21、3372879 节点。Pikafish 峰值 RSS 为 359084KB（约 351MB），系统最低可用内存 853MB，1GB Swap 全程使用量为 0。

## 取消与规则回归

- 5 秒分析在 250ms 被客户端主动断开，curl 按预期返回超时状态 28。
- 随后的 D3 `/move` 请求在 2ms 内正常返回，说明 `stop`、输出排空和 `MultiPV=1` 恢复有效。
- 长将测试使用完整七步历史：`e0f0 e2f2 f0e0 f2e2 e0f0 e2f2 f0e0`。
- 黑方返回 `f2b2`，没有选择会继续重复将军的 `f2e2`。

## 电视显示链路

Android `DisplayInfo` 和应用缓冲仍为 1920×1080。显示驱动报告：

```text
hdmi output mode(35)  fps:60.6  4096x2160
BUF fb[1920,1080] crop[0,0,1920,1080]
```

因此应用继续按 1080P 安全区绘制，由盒子硬件缩放至 4096×2160。主界面、分析弹层、三路候选以及紫色棋盘高亮均未出现裁切或溢出。

## 最终 APK

```text
android/app/build/outputs/apk/debug/app-debug.apk
Size: 4070438 bytes
SHA-256: 402e6c9603616e14f12180c76c238d41da0cdd6173f13edf21a3559b65793996
Permissions: android.permission.INTERNET only
Signing: v1 + v2 verified
Cold start: 1760ms
```

最终 APK 已通过 ADB 覆盖安装，应用进程与 `com.xiangqitv.app/.MainActivity` 前台状态正常。
