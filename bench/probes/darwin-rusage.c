/*
 * darwin-rusage — one JSON line of proc_pid_rusage(RUSAGE_INFO_V4) for a PID.
 *
 * Compiled on demand by bench/lib/rusage.ts. This machine's plain `cc` cannot
 * link (docs/engine/CURRENT-STATE.md §12), so the build is always:
 *
 *   xcrun --sdk macosx clang -O2 -isysroot "$(xcrun --sdk macosx --show-sdk-path)" \
 *       -o darwin-rusage darwin-rusage.c
 *
 * Usage: darwin-rusage <pid>   (any process of the same user; no root needed)
 *
 * Output, one line:
 *   {"pid":N,"diskBytesRead":N,"diskBytesWritten":N,"userNs":N,"systemNs":N,
 *    "childUserNs":N,"childSystemNs":N,"peakFootprint":N}
 *
 * The kernel reports ri_user_time, ri_system_time and the two ri_child_*_time
 * counters in mach absolute-time ticks, not nanoseconds. On Apple Silicon the
 * timebase is 125/3 (24 MHz ticks): measured on an M3 on 18 Sep 2026, a
 * process that getrusage said had used 419.5 ms of user CPU showed
 * ri_user_time = 10,075,654, which is 419.8 ms only after multiplying by
 * 125/3. On Intel the timebase is 1/1 and the raw value already is
 * nanoseconds. The four *Ns fields are therefore converted through
 * mach_timebase_info so that they are nanoseconds on both. The byte and
 * footprint counters are already bytes and are printed as they come.
 *
 * ri_diskio_bytesread counts bytes this task pulled from the device itself:
 * page-cache hits do not count, and neither does I/O done by child processes.
 * ri_child_*_time accumulate only as children are reaped (waited for).
 */
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <mach/kern_return.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>

/*
 * ticks * numer / denom without a 128-bit intermediate: split the quotient
 * and the remainder so nothing overflows before ~584 years of CPU time.
 */
static uint64_t ticks_to_nanoseconds(uint64_t ticks, const mach_timebase_info_data_t *timebase)
{
    if (timebase->numer == timebase->denom) {
        return ticks;
    }
    uint64_t whole = ticks / timebase->denom;
    uint64_t rest = ticks % timebase->denom;
    return whole * timebase->numer + (rest * timebase->numer) / timebase->denom;
}

static int parse_pid(const char *text, int *pid_out)
{
    char *end = NULL;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value <= 0 || value > INT_MAX) {
        return -1;
    }
    *pid_out = (int)value;
    return 0;
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "usage: darwin-rusage <pid>\n");
        return 2;
    }
    int pid = 0;
    if (parse_pid(argv[1], &pid) != 0) {
        fprintf(stderr, "darwin-rusage: not a pid: %s\n", argv[1]);
        return 2;
    }
    mach_timebase_info_data_t timebase = { 0, 0 };
    if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) {
        fprintf(stderr, "darwin-rusage: mach_timebase_info failed\n");
        return 1;
    }
    struct rusage_info_v4 ri;
    memset(&ri, 0, sizeof ri);
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&ri) != 0) {
        fprintf(stderr, "darwin-rusage: proc_pid_rusage(%d, RUSAGE_INFO_V4) failed: %s\n",
                pid, strerror(errno));
        return 1;
    }
    printf("{\"pid\":%d"
           ",\"diskBytesRead\":%" PRIu64
           ",\"diskBytesWritten\":%" PRIu64
           ",\"userNs\":%" PRIu64
           ",\"systemNs\":%" PRIu64
           ",\"childUserNs\":%" PRIu64
           ",\"childSystemNs\":%" PRIu64
           ",\"peakFootprint\":%" PRIu64 "}\n",
           pid,
           ri.ri_diskio_bytesread,
           ri.ri_diskio_byteswritten,
           ticks_to_nanoseconds(ri.ri_user_time, &timebase),
           ticks_to_nanoseconds(ri.ri_system_time, &timebase),
           ticks_to_nanoseconds(ri.ri_child_user_time, &timebase),
           ticks_to_nanoseconds(ri.ri_child_system_time, &timebase),
           ri.ri_lifetime_max_phys_footprint);
    return 0;
}
