# 加密备份与恢复演练

管理员在离线电脑生成 age 密钥：

```powershell
age-keygen -o soda-reading-backup.agekey
```

把输出的 `age1...` 公钥保存为 GitHub Secret `AGE_PUBLIC_KEY`；私钥文件只离线保存，不上传 GitHub、Supabase、Cloudflare 或 Expo。

每天下载 GitHub Artifact 后，先校验 `SHA256SUMS`。恢复演练必须使用新建的临时 PostgreSQL 数据库，不能直接覆盖正在使用的 Supabase：

```powershell
.\scripts\restore-backup.ps1 `
  -EncryptedDump .\soda-reading.dump.age `
  -AgeIdentityFile D:\Offline\soda-reading-backup.agekey `
  -RestoreDatabaseUrl "postgresql://user:password@localhost:5432/soda_restore_test"
```

恢复后至少检查：

```sql
select count(*) from profiles;
select count(*) from article_variants where review_status = 'approved';
select edition_date, status, jsonb_array_length(article_ids)
from daily_editions order by edition_date desc limit 7;
select count(*) from vocabulary_reviews;
```

首次内部使用前完成一次；之后每月一次。演练成功只记录日期和结果，不记录私钥、数据库密码或用户学习内容。
