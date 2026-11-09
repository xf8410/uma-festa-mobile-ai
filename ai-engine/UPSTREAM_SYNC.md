# ai-engine 上游同步（2026-11-09）

- 上游 https://github.com/umaai-project/umaai-matsuri @ main + **PR#3 合入**（b66db8f）
  - PR#3 = GA 三档定参（default/stamina_build/wisdom_build）+ 在线按帧内卡组选档 + 自选比赛期限回合只搜比赛
  - PR#3 未进上游 main（open），手机版先行合入构建；上游合并后可回到纯 main
- 上游 https://github.com/umaai-project/umaai-next @ 35ba2d5
  - 35ba2d5 feat(umaai): 帧通道终局帧识别改文件名模式 + 终局帧动作数组（E1/E2）
- 手机端运行方式：CI（build-app-v2.yml）克隆上游 main + 合 PR#3 + 打 panel/view JSON 补丁，
  交叉编译 matsuri-cli 为 libmatsuri_engine.so 打进 APK，由 EngineBridge 以 online 模式双档（matsuri/search）子进程运行。
