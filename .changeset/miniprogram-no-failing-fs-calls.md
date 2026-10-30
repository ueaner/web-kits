---
"cross-sqlite-client": patch
---

Mini program adapter: stop the two failing file calls on every launch. WeChat logs every failed file system call, even one the adapter expects and ignores, so each launch logged `unlink:fail no such file or directory … <name>.sqlite.tmp`, and `mkdir` failed on the existing directory. When the host's file system has `readdir` (WeChat's does), the adapter now lists the database directory once on open: it creates the directory only when the listing fails, and deletes a leftover `.tmp` only when the listing shows one. The listing decides nothing else — reading the database and its backup, and rotating the backup on save, work as before — so a host whose `readdir` misbehaves at worst logs a failed call again, never treats an existing database as new. Without `readdir` the adapter works as before.
