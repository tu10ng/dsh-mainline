# HALT 备份脚本加固 {#bk01}

夜间备份脚本偶尔没有产出，且没有任何告警；先查原因，再让脚本在失败时明确报错。

## REF 设计 {#bk02}

指向备份方案的笔记，遗留疑问：脚本是否在磁盘满时静默退出。

## REF 日志 {#bk03}

脚本的日志在 /var/log/backup.log，logrotate 每周轮转。

## REF code {#bk04}

梳理调用链：backup.sh → run_rsync → verify_snapshot，以及退出码与锁文件的约定。

## TODO ? 磁盘满时脚本是否静默退出 {#bk10}

遗留疑问。

## FORK 两个猜想 {#bk11}

### cron 没跑 {#bk12}

#### TODO 待验证 {#bk13}

### 脚本提前退出 {#bk14}

#### TODO 待验证 {#bk15}

## HALT 把读取配置的函数提出来 {#bk20}

重构点：读取配置的函数应提取为公共脚本。

## 测试 {#bk21}

### REF test {#bk22}

通过下面的命令验证备份是否产出：

```bash
df -h
ls -l /mnt/usb
```
