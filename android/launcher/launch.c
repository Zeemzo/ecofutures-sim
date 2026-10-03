// Starts anvil with a clean signal state. A process an Android app starts inherits the Java runtime's blocked and
// ignored signals (SIGQUIT, SIGUSR1, SIGPIPE and signal 32 among them), which a program built for Linux does not
// expect. This clears both and execs argv[1] with the rest of the arguments.
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
    for (int s = 1; s < NSIG; s++) signal(s, SIG_DFL);
    execv(argv[1], argv + 1);
    perror("execv");
    return 127;
}
