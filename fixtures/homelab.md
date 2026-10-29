# HALT NAS 迁移到 ZFS {#hl01}

把家里的 NAS 从旧的 ext4 + mdadm 阵列迁到 ZFS：两台机器（nas-a 做主、nas-b 做备份），数据先备份、再建池、再导回，最后验证重启后自动挂载。

## REF 设计笔记 {#hl02}

存放选型笔记：为什么选 raidz1 而不是镜像，快照策略与保留周期，以及回滚预案的链接。

## REF 磁盘清单 {#hl03}

三块旧盘（2×4T + 1×2T）和两块新盘（各 8T），分别标注型号、通电时长与 SMART 状态。

### 旧阵列 {#hl04}

mdadm 的 RAID1，挂载在 /mnt/old，容量 3.6T，已用 2.1T。

### 新盘 {#hl05}

两块 8T 的 CMR 盘，装在 nas-a；购买记录见设计笔记。

### zpool 布局 {#hl06}

nas-a 用 raidz1，nas-b 用单盘 + 定期 send/recv。

## REF (cmd) 状态 {#hl07}

查看池、数据集与磁盘健康的常用命令：

```bash
zpool status
zfs list -o name,used,avail
smartctl -a /dev/sda
```

## REF 回滚预案 {#hl08}

旧阵列在迁移完成两周内不拆，必要时把 /mnt/old 重新挂回即可。

## REF 参考 {#hl09}

OpenZFS 文档与社区里关于 ashift、recordsize 的讨论链接。

## 备份旧数据 {#hl10}

先把 /mnt/old 整体备份到外接硬盘，核对文件数量，再动任何一块盘。

### REF 备份位置 {#hl11}

外接硬盘挂载在 /mnt/usb，目录按日期命名。

### REF rsync 参数 {#hl12}

先用 --dry-run 看一遍会拷什么：

```bash
rsync -aHv --dry-run /mnt/old/ /tank/data/
```

## 盘位与接线 {#hl13}

确认每块盘对应的接口和线序，避免装反。

### REF 盘位图 {#hl14}

机箱前面板从左到右依次是 sda、sdb、sdc。

## FORK 两台机器 {#hl20}

### nas-a {#hl21}

主力机，装两块新盘，建 raidz1 池并承载全部数据。

#### 装盘 {#hl22}

关机、装盘、开机，确认系统识别到新盘。

##### REF 盘位 {#hl23}

新盘插在第 4、5 个盘位。

```bash
lsblk -f
```

#### 建池 {#hl24}

用 by-id 路径建池，ashift 设为 12。

##### REF 建池命令 {#hl25}

建好以后立刻看状态：

```bash
zpool status
```

#### 导入数据 {#hl26}

把备份导回 tank/data，先 dry-run 再正式拷。

##### REF rsync {#hl27}

```bash
rsync -aHv --dry-run /mnt/old/ /tank/data/
```

#### 验证 {#hl28}

看池状态、容量，再抽查几个大文件的校验和。

##### REF test {#hl29}

```bash
zfs list -o name,used,avail
df -h
```

### nas-b {#hl31}

备份机，沿用旧盘，只做 send/recv 的目标。

#### 清点旧盘 {#hl32}

把旧盘逐块接上，记录型号与序列号。

#### 换盘 {#hl33}

2T 的那块 SMART 有重分配扇区，换成新盘。

##### REF smart 报告 {#hl34}

换盘前后的报告都存档：

```bash
smartctl -a /dev/sda
```

##### REF 校验 {#hl35}

换盘后跑一次 scrub，确认没有校验错误。

###### 校验清单 {#hl36}

scrub 结束后记录错误数与耗时。

#### 内核日志 {#hl37}

看换盘时内核有没有报链路错误。

```bash
dmesg | grep -i ata
```

#### 验证 {#hl38}

```bash
lsblk -f
zpool status
```

## 调整挂载点 {#hl40}

把 /tank/data 挂回原来的路径，更新 fstab 和共享配置。

## 增加迁移日志 {#hl41}

每一步的命令和输出都记到迁移日志里，方便事后复盘。

## HALT ? 确认 ashift 是否设为 12 {#hl42}

确认过：两块新盘都是 4K 扇区，建池时显式指定 ashift=12，zpool get ashift tank 返回 12。

## HALT 评审快照策略，复核容量 {#hl43}

### REF 遗留问题 {#hl44}

快照保留周期还没定，先按每天一份保留七天。

## HALT 验证重启后自动挂载 {#hl45}

## HALT 收尾 {#hl46}
