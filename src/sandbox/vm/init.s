# The guest's init, PID 1 for the guest's whole life. The Bun runtime cannot start before /proc is
# mounted, and the guest has no static program of its own, so this one prepares the guest, starts
# the worker without privileges, reaps the processes orphaned to it while the worker runs, and
# powers the guest off once the worker ends, which ends whatever is left without waiting for it.
# Should the guest not end, the host ends QEMU at its own timeout. Every call that can fail is checked: a failure is written to the console, and the
# init ends QEMU through its debug-exit device with a status of its own, so that the host tells a
# failed start from a guest that ended; it never leaves PID 1, which would make the kernel panic.
#
# The code is fixed. What changes with each session is a plan of tables at DATA, which the host
# writes, with absolute pointers:
#   0x00 the mounts made first: source, target, type, flags, data; ended by a zero source
#   0x08 the directories made in them: path, mode; ended by a zero path
#   0x10 the mounts made on those directories, as the first
#   0x18 the links made in them: target, path; ended by a zero target
#   0x20 the modules: path, flags of finit_module; ended by a zero path
#   0x28 the mounts of the exports, as the first
#   0x30 the files whose content must be exactly as given: path, content, length; ended by a zero
#        path. Each is retried until it is, for devices the kernel adds a moment after their driver
#   0x38 the netlink messages that configure the network: message, length; ended by a zero message
#   0x40 the path of the port the host writes to, given to the worker as descriptor 3
#   0x48 the path of the port the host reads from, given to the worker as descriptor 4
#   0x50 the worker's path, 0x58 its arguments, 0x60 its environment, 0x68 its directory
#   0x70 its user id, 0x78 its group id
#
# x86-64 system call numbers.
    .set SYS_read, 0
    .set SYS_write, 1
    .set SYS_open, 2
    .set SYS_close, 3
    .set SYS_dup2, 33
    .set SYS_pause, 34
    .set SYS_nanosleep, 35
    .set SYS_socket, 41
    .set SYS_sendto, 44
    .set SYS_recvfrom, 45
    .set SYS_fork, 57
    .set SYS_execve, 59
    .set SYS_wait4, 61
    .set SYS_chdir, 80
    .set SYS_mkdir, 83
    .set SYS_symlink, 88
    .set SYS_setgroups, 116
    .set SYS_setresuid, 117
    .set SYS_setresgid, 119
    .set SYS_prctl, 157
    .set SYS_ioperm, 173
    .set SYS_sync, 162
    .set SYS_mount, 165
    .set SYS_reboot, 169
    .set SYS_exit_group, 231
    .set SYS_finit_module, 313

    .set DATA, 0x600000
    .set O_WRONLY, 1
    .set O_RDWR, 2
    .set O_CLOEXEC, 0x80000
    .set EINTR, 4
    .set EEXIST, 17
    .set EINVAL, 22
    .set AF_NETLINK, 16
    .set SOCK_RAW_CLOEXEC, 0x80003
    .set NLMSG_ERROR, 2
    .set PR_CAPBSET_DROP, 24
    .set PR_SET_NO_NEW_PRIVS, 38
    .set LAST_CAPABILITY, 63
    .set CHECK_TRIES, 500
    # QEMU's isa-debug-exit device: writing 1 to its port ends QEMU with the status (1 << 1) | 1.
    .set DEBUG_EXIT_PORT, 0x501
    # What the worker's child exits with when it cannot run the worker.
    .set CHILD_FAILED, 127
    .set BUFFER, 4096

    .globl _start
    .text
_start:
    # A buffer for reads and a slot for wait4's status, at %rbp, above everything the calls below
    # push.
    sub $BUFFER+16, %rsp
    mov %rsp, %rbp

    mov DATA+0x00, %rbx
    call mount_all
    mov DATA+0x08, %rbx
    call make_directories
    mov DATA+0x10, %rbx
    call mount_all
    mov DATA+0x18, %rbx
    call make_links
    mov DATA+0x20, %rbx
    call load_modules
    mov DATA+0x28, %rbx
    call mount_all
    mov DATA+0x30, %rbx
    call check_files
    mov DATA+0x38, %rbx
    call configure_network

    mov $SYS_fork, %eax
    syscall
    lea m_fork(%rip), %rsi
    xor %edi, %edi
    test %rax, %rax
    js fail
    jz worker
    mov %rax, %r14

# Reaps every child until the worker is among them, or none is left. A worker's child that could
# not run the worker is a failed start.
reap:
    mov $SYS_wait4, %eax
    mov $-1, %rdi
    lea BUFFER(%rbp), %rsi
    xor %edx, %edx
    xor %r10d, %r10d
    syscall
    cmp %r14, %rax
    je worker_ended
    cmp $-EINTR, %rax
    je reap
    test %rax, %rax
    jns reap
    jmp power_off
worker_ended:
    mov BUFFER(%rbp), %eax
    and $0xffff, %eax
    cmp $CHILD_FAILED << 8, %eax
    je failed

power_off:
    mov $SYS_sync, %eax
    syscall
    mov $SYS_reboot, %eax
    mov $0xfee1dead, %edi
    mov $0x28121969, %esi
    mov $0x4321fedc, %edx
    xor %r10d, %r10d
    syscall
# Should the kernel refuse, PID 1 waits rather than exits.
hang:
    mov $SYS_pause, %eax
    syscall
    jmp hang

# The worker, in the child: the ports as descriptors 3 and 4, nothing to read and nowhere to write
# on 0 and 1, its errors still on the console, its directory, no capability left to gain, no
# supplementary group, the user's ids, and no new privileges across exec.
worker:
    mov DATA+0x40, %rdi
    xor %esi, %esi
    mov $3, %r12d
    call open_as
    mov DATA+0x48, %rdi
    mov $O_WRONLY, %esi
    mov $4, %r12d
    call open_as
    lea s_null(%rip), %rdi
    mov $O_RDWR, %esi
    xor %r12d, %r12d
    call open_as
    mov $SYS_dup2, %eax
    xor %edi, %edi
    mov $1, %esi
    syscall
    lea m_open(%rip), %rsi
    lea s_null(%rip), %rdi
    test %rax, %rax
    js child_fail

    mov $SYS_chdir, %eax
    mov DATA+0x68, %rdi
    syscall
    lea m_chdir(%rip), %rsi
    mov DATA+0x68, %rdi
    test %rax, %rax
    js child_fail

    xor %r12d, %r12d
drop_capability:
    mov $SYS_prctl, %eax
    mov $PR_CAPBSET_DROP, %edi
    mov %r12, %rsi
    xor %edx, %edx
    xor %r10d, %r10d
    xor %r8d, %r8d
    syscall
    # A capability this kernel does not have is refused as invalid; any other refusal is a failure.
    cmp $-EINVAL, %rax
    je next_capability
    lea m_capability(%rip), %rsi
    xor %edi, %edi
    test %rax, %rax
    js child_fail
next_capability:
    inc %r12
    cmp $LAST_CAPABILITY, %r12
    jbe drop_capability

    mov $SYS_setgroups, %eax
    xor %edi, %edi
    xor %esi, %esi
    syscall
    lea m_groups(%rip), %rsi
    xor %edi, %edi
    test %rax, %rax
    js child_fail

    mov $SYS_setresgid, %eax
    mov DATA+0x78, %rdi
    mov %rdi, %rsi
    mov %rdi, %rdx
    syscall
    lea m_gid(%rip), %rsi
    xor %edi, %edi
    test %rax, %rax
    js child_fail

    mov $SYS_setresuid, %eax
    mov DATA+0x70, %rdi
    mov %rdi, %rsi
    mov %rdi, %rdx
    syscall
    lea m_uid(%rip), %rsi
    xor %edi, %edi
    test %rax, %rax
    js child_fail

    mov $SYS_prctl, %eax
    mov $PR_SET_NO_NEW_PRIVS, %edi
    mov $1, %esi
    xor %edx, %edx
    xor %r10d, %r10d
    xor %r8d, %r8d
    syscall
    lea m_privileges(%rip), %rsi
    xor %edi, %edi
    test %rax, %rax
    js child_fail

    mov $SYS_execve, %eax
    mov DATA+0x50, %rdi
    mov DATA+0x58, %rsi
    mov DATA+0x60, %rdx
    syscall
    lea m_exec(%rip), %rsi
    mov DATA+0x50, %rdi
    jmp child_fail

# Opens the path at %rdi with the flags in %esi as descriptor %r12, without close-on-exec. The
# lowest free descriptor is taken, so that one below %r12 is never left open by mistake: the ports
# are opened first, as 3 and 4, while only the console's 0 to 2 are open.
open_as:
    mov %rdi, %r13
    mov $SYS_open, %eax
    xor %edx, %edx
    syscall
    lea m_open(%rip), %rsi
    mov %r13, %rdi
    test %rax, %rax
    js child_fail
    cmp %r12, %rax
    je opened
    mov %rax, %r13
    mov %rax, %rdi
    mov %r12, %rsi
    mov $SYS_dup2, %eax
    syscall
    lea m_open(%rip), %rsi
    xor %edi, %edi
    test %rax, %rax
    js child_fail
    mov $SYS_close, %eax
    mov %r13, %rdi
    syscall
opened:
    ret

# Mounts each entry of the table at %rbx.
mount_all:
    mov (%rbx), %rdi
    test %rdi, %rdi
    jz mounted
    mov $SYS_mount, %eax
    mov 8(%rbx), %rsi
    mov 16(%rbx), %rdx
    mov 24(%rbx), %r10
    mov 32(%rbx), %r8
    syscall
    lea m_mount(%rip), %rsi
    mov 8(%rbx), %rdi
    test %rax, %rax
    js fail
    add $40, %rbx
    jmp mount_all
mounted:
    ret

# Makes each directory of the table at %rbx; one that exists already is no failure.
make_directories:
    mov (%rbx), %rdi
    test %rdi, %rdi
    jz made
    mov $SYS_mkdir, %eax
    mov 8(%rbx), %rsi
    syscall
    cmp $-EEXIST, %rax
    je directory_done
    lea m_directory(%rip), %rsi
    mov (%rbx), %rdi
    test %rax, %rax
    js fail
directory_done:
    add $16, %rbx
    jmp make_directories
made:
    ret

# Makes each link of the table at %rbx.
make_links:
    mov (%rbx), %rdi
    test %rdi, %rdi
    jz linked
    mov $SYS_symlink, %eax
    mov 8(%rbx), %rsi
    syscall
    lea m_link(%rip), %rsi
    mov 8(%rbx), %rdi
    test %rax, %rax
    js fail
    add $16, %rbx
    jmp make_links
linked:
    ret

# Loads each module of the table at %rbx; one the kernel holds already is no failure.
load_modules:
    mov (%rbx), %rdi
    test %rdi, %rdi
    jz loaded
    mov $SYS_open, %eax
    mov $O_CLOEXEC, %esi
    xor %edx, %edx
    syscall
    lea m_module(%rip), %rsi
    mov (%rbx), %rdi
    test %rax, %rax
    js fail
    mov %rax, %r12
    mov $SYS_finit_module, %eax
    mov %r12, %rdi
    lea empty(%rip), %rsi
    mov 8(%rbx), %rdx
    syscall
    cmp $-EEXIST, %rax
    je module_done
    lea m_module(%rip), %rsi
    mov (%rbx), %rdi
    test %rax, %rax
    js fail
module_done:
    mov $SYS_close, %eax
    mov %r12, %rdi
    syscall
    add $16, %rbx
    jmp load_modules
loaded:
    ret

# Waits until each file of the table at %rbx holds exactly its content, CHECK_TRIES times 10 ms at
# most.
check_files:
    mov (%rbx), %rdi
    test %rdi, %rdi
    jz checked
    mov $CHECK_TRIES, %r13d
check_again:
    mov $SYS_open, %eax
    mov (%rbx), %rdi
    mov $O_CLOEXEC, %esi
    xor %edx, %edx
    syscall
    test %rax, %rax
    js check_wait
    mov %rax, %r12
    mov $SYS_read, %eax
    mov %r12, %rdi
    mov %rbp, %rsi
    mov $BUFFER, %edx
    syscall
    mov %rax, %rcx
    push %rcx
    mov $SYS_close, %eax
    mov %r12, %rdi
    syscall
    pop %rcx
    cmp 16(%rbx), %rcx
    jne check_wait
    mov %rbp, %rsi
    mov 8(%rbx), %rdi
compare:
    test %rcx, %rcx
    jz check_next
    mov (%rsi), %al
    cmp (%rdi), %al
    jne check_wait
    inc %rsi
    inc %rdi
    dec %rcx
    jmp compare
check_wait:
    dec %r13d
    jnz check_sleep
    lea m_check(%rip), %rsi
    mov (%rbx), %rdi
    xor %eax, %eax
    jmp fail
check_sleep:
    mov $SYS_nanosleep, %eax
    lea ten_ms(%rip), %rdi
    xor %esi, %esi
    syscall
    jmp check_again
check_next:
    add $24, %rbx
    jmp check_files
checked:
    ret

# Sends each netlink message of the table at %rbx and requires the kernel's acknowledgement of
# each, with no error.
configure_network:
    mov $SYS_socket, %eax
    mov $AF_NETLINK, %edi
    mov $SOCK_RAW_CLOEXEC, %esi
    xor %edx, %edx
    syscall
    lea m_network(%rip), %rsi
    xor %edi, %edi
    test %rax, %rax
    js fail
    mov %rax, %r12
next_message:
    mov (%rbx), %rsi
    test %rsi, %rsi
    jz configured
    mov $SYS_sendto, %eax
    mov %r12, %rdi
    mov 8(%rbx), %rdx
    xor %r10d, %r10d
    lea kernel_address(%rip), %r8
    mov $12, %r9d
    syscall
    lea m_network(%rip), %rsi
    xor %edi, %edi
    test %rax, %rax
    js fail
    mov $SYS_recvfrom, %eax
    mov %r12, %rdi
    mov %rbp, %rsi
    mov $BUFFER, %edx
    xor %r10d, %r10d
    xor %r8d, %r8d
    xor %r9d, %r9d
    syscall
    lea m_network(%rip), %rsi
    xor %edi, %edi
    test %rax, %rax
    js fail
    # An acknowledgement: a header of the error type, whose error is zero.
    cmp $36, %rax
    mov $-EINVAL, %rax
    jb fail
    cmpw $NLMSG_ERROR, 4(%rbp)
    jne fail
    movslq 16(%rbp), %rax
    test %rax, %rax
    jnz fail
    add $16, %rbx
    jmp next_message
configured:
    mov $SYS_close, %eax
    mov %r12, %rdi
    syscall
    ret

# Writes "nullrivet init: <%rsi>[: <%rdi>][ (error <-%rax>)]" to the console. In the init the start
# then fails; in the worker's child, the child exits, and the init fails the start once it has
# reaped it.
fail:
    call report
failed:
    mov $SYS_ioperm, %eax
    mov $DEBUG_EXIT_PORT, %edi
    mov $1, %esi
    mov $1, %edx
    syscall
    test %rax, %rax
    js power_off
    mov $1, %al
    mov $DEBUG_EXIT_PORT, %dx
    outb %al, %dx
    jmp power_off
child_fail:
    call report
    mov $SYS_exit_group, %eax
    mov $CHILD_FAILED, %edi
    syscall

report:
    mov %rax, %r12
    neg %r12
    mov %rdi, %r13
    push %rsi
    lea m_prefix(%rip), %rsi
    call say
    pop %rsi
    call say
    test %r13, %r13
    jz report_error
    lea m_colon(%rip), %rsi
    call say
    mov %r13, %rsi
    call say
report_error:
    test %r12, %r12
    jz report_end
    lea m_error(%rip), %rsi
    call say
    # The error number in decimal, written backwards from the end of the buffer.
    lea BUFFER+15(%rbp), %rsi
    movb $0, (%rsi)
    mov %r12, %rax
    mov $10, %ecx
digit:
    xor %edx, %edx
    div %rcx
    add $'0', %dl
    dec %rsi
    mov %dl, (%rsi)
    test %rax, %rax
    jnz digit
    call say
    lea m_close(%rip), %rsi
    call say
report_end:
    lea m_end(%rip), %rsi
    call say
    ret

# Writes the NUL-terminated string at %rsi to descriptor 2.
say:
    mov %rsi, %rdx
length:
    cmpb $0, (%rdx)
    je write
    inc %rdx
    jmp length
write:
    sub %rsi, %rdx
    mov $SYS_write, %eax
    mov $2, %edi
    syscall
    ret

empty:          .asciz ""
s_null:         .asciz "/dev/null"
m_prefix:       .asciz "nullrivet init: "
m_colon:        .asciz ": "
m_error:        .asciz " (error "
m_close:        .asciz ")"
m_end:          .asciz "\n"
m_mount:        .asciz "cannot mount"
m_directory:    .asciz "cannot make the directory"
m_link:         .asciz "cannot make the link"
m_module:       .asciz "cannot load the module"
m_check:        .asciz "does not hold what was expected"
m_network:      .asciz "cannot configure the network"
m_fork:         .asciz "cannot start the worker"
m_open:         .asciz "cannot open the port"
m_chdir:        .asciz "cannot enter the worker's directory"
m_capability:   .asciz "cannot drop a capability"
m_groups:       .asciz "cannot drop the supplementary groups"
m_gid:          .asciz "cannot set the group id"
m_uid:          .asciz "cannot set the user id"
m_privileges:   .asciz "cannot refuse new privileges"
m_exec:         .asciz "cannot run the worker"
    .balign 8
ten_ms:         .quad 0, 10000000
# A sockaddr_nl of the kernel: AF_NETLINK, no port, no group.
kernel_address: .short AF_NETLINK, 0
                .long 0, 0
