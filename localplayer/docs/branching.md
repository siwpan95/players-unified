# 分支模型（GitFlow 简化版）

本仓库采用 gitee「开发 / 发布 / 缺陷分离」模型，常用分支如下：

- `master`：稳定可发布版本，每次发布打 `vX.Y.Z` tag。
- `develop`：日常集成分支，功能在此汇合。
- `feature/<名>`：从 `develop` 切出，做完合回 `develop`。
- `release/<版>`：发版前从 `develop` 拉出，定版后合回 `master` + `develop` 并打 tag。
- `hotfix/<版>`：从 `master` 切出修紧急问题，合回 `master` + `develop`。

## 常用命令

```bash
# 开功能分支
git checkout develop
git checkout -b feature/my-feature
# ... 改动 ...
git add -A && git commit -m "feat: ..."
git push -u origin feature/my-feature
# 在 gitee 提 PR：feature/my-feature -> develop，合并后删除分支
```

> 推送如需临时使用 gitee 私人令牌（令牌在**密码位**，不是用户名）：
> `git remote set-url origin https://<账号>:<令牌>@gitee.com/siwpan/localplayer.git`
> 推送完再 `git remote set-url origin https://gitee.com/siwpan/localplayer.git` 还原，避免令牌落盘。
