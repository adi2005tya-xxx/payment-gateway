import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

// Improved version of the LLD payment gateway:
//  - money in integer paise (no double)
//  - PaymentResult carries a reason, so the proxy retries ONLY transient failures
//  - idempotency key: the same request is never charged twice
//  - no shared mutable gateway in the service (thread-safe, no race between setGateway and process)
//  - Strategy (banking), Template Method (gateway flow), Proxy (retry), Factory (registry), Singleton (service)

enum Status { SUCCESS, VALIDATION_FAILED, DECLINED, CONFIRMATION_FAILED }

record PaymentRequest(String idempotencyKey, String sender, String receiver, long amountPaise, String currency) {}

record PaymentResult(Status status, String txnId, String message) {
    boolean ok() { return status == Status.SUCCESS; }
    // Only a bank decline may be transient; a validation failure will never succeed on retry.
    boolean retryable() { return status == Status.DECLINED; }
}

// ---- Strategy: the bank behind the gateway ----
interface BankingSystem {
    boolean charge(long amountPaise);
}

class SimulatedBank implements BankingSystem {
    private final int successPercent;
    private final Random rand;
    SimulatedBank(int successPercent, long seed) { this.successPercent = successPercent; this.rand = new Random(seed); }
    public synchronized boolean charge(long amountPaise) {
        // Same behaviour and logging for every provider; success rate is the only difference.
        System.out.printf("[Bank %d%%] processing %s%n", successPercent, Money.fmt(amountPaise, ""));
        return rand.nextInt(100) < successPercent;
    }
}

// ---- Template Method ----
abstract class PaymentGateway {
    protected final String name;
    protected final BankingSystem bank;
    private static final AtomicInteger SEQ = new AtomicInteger();

    PaymentGateway(String name, BankingSystem bank) { this.name = name; this.bank = bank; }

    public PaymentResult process(PaymentRequest r) {
        String txn = name + "-" + SEQ.incrementAndGet();
        if (!validate(r)) return new PaymentResult(Status.VALIDATION_FAILED, txn, "validation failed");
        System.out.printf("[%s] charging %s for %s%n", name, Money.fmt(r.amountPaise(), r.currency()), r.sender());
        if (!bank.charge(r.amountPaise())) return new PaymentResult(Status.DECLINED, txn, "bank declined");
        if (!confirm(r)) return new PaymentResult(Status.CONFIRMATION_FAILED, txn, "confirmation failed");
        return new PaymentResult(Status.SUCCESS, txn, "ok");
    }

    protected boolean validate(PaymentRequest r) {
        return r.amountPaise() > 0 && r.sender() != null && r.receiver() != null && !r.sender().equals(r.receiver());
    }
    protected boolean confirm(PaymentRequest r) { return true; }
}

class PaytmGateway extends PaymentGateway {
    PaytmGateway(BankingSystem b) { super("Paytm", b); }
    @Override protected boolean validate(PaymentRequest r) { return super.validate(r) && "INR".equals(r.currency()); }
}

class RazorpayGateway extends PaymentGateway {
    RazorpayGateway(BankingSystem b) { super("Razorpay", b); }
}

// ---- Proxy: retry with backoff, transient failures only ----
class RetryingGateway extends PaymentGateway {
    private final PaymentGateway real;
    private final int maxAttempts;

    RetryingGateway(PaymentGateway real, int maxAttempts) {
        super(real.name, real.bank);
        this.real = real;
        this.maxAttempts = maxAttempts;
    }

    @Override public PaymentResult process(PaymentRequest r) {
        PaymentResult res = null;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            if (attempt > 1) System.out.printf("[Proxy] retry %d/%d for %s%n", attempt, maxAttempts, r.sender());
            res = real.process(r);
            if (res.ok() || !res.retryable()) return res;
        }
        System.out.printf("[Proxy] failed after %d attempts for %s%n", maxAttempts, r.sender());
        return res;
    }
}

// ---- Factory ----
enum GatewayType { PAYTM, RAZORPAY }

final class GatewayFactory {
    private static final GatewayFactory INSTANCE = new GatewayFactory();
    // One bank connection per provider, shared across requests (a bank is not per-request state).
    private final BankingSystem paytmBank = new SimulatedBank(80, System.nanoTime());
    private final BankingSystem razorpayBank = new SimulatedBank(90, System.nanoTime() + 1);
    private GatewayFactory() {}
    static GatewayFactory getInstance() { return INSTANCE; }

    PaymentGateway create(GatewayType t) {
        return switch (t) {
            case PAYTM -> new RetryingGateway(new PaytmGateway(paytmBank), 3);
            case RAZORPAY -> new RetryingGateway(new RazorpayGateway(razorpayBank), 1);
        };
    }
}

// ---- Service: idempotent, stateless w.r.t. gateway choice ----
final class PaymentService {
    private static final PaymentService INSTANCE = new PaymentService();
    private final ConcurrentMap<String, PaymentResult> done = new ConcurrentHashMap<>();
    private PaymentService() {}
    static PaymentService getInstance() { return INSTANCE; }

    PaymentResult process(PaymentGateway gateway, PaymentRequest r) {
        // computeIfAbsent: concurrent duplicates of one key run the charge once
        return done.computeIfAbsent(r.idempotencyKey(), k -> gateway.process(r));
    }
}

final class PaymentController {
    private static final PaymentController INSTANCE = new PaymentController();
    private PaymentController() {}
    static PaymentController getInstance() { return INSTANCE; }

    PaymentResult handle(GatewayType type, PaymentRequest r) {
        return PaymentService.getInstance().process(GatewayFactory.getInstance().create(type), r);
    }
}

final class Money {
    static String fmt(long paise, String cur) { return String.format("%d.%02d %s", paise / 100, paise % 100, cur); }
}

public class PaymentGatewayApplication {
    static int failures = 0;

    static void check(String label, boolean cond) {
        System.out.println((cond ? "  PASS " : "  FAIL ") + label);
        if (!cond) failures++;
    }

    public static void main(String[] args) throws Exception {
        PaymentController c = PaymentController.getInstance();

        System.out.println("== Paytm, valid INR");
        PaymentResult a = c.handle(GatewayType.PAYTM, new PaymentRequest("k1", "Aditya", "Shubham", 100000, "INR"));
        System.out.println("Result: " + a);

        System.out.println("== Paytm, USD: must fail validation with NO retries");
        PaymentResult b = c.handle(GatewayType.PAYTM, new PaymentRequest("k2", "Shubham", "Aditya", 50000, "USD"));
        check("USD rejected by Paytm", b.status() == Status.VALIDATION_FAILED);

        System.out.println("== Razorpay, USD accepted");
        PaymentResult d = c.handle(GatewayType.RAZORPAY, new PaymentRequest("k3", "Shubham", "Aditya", 50000, "USD"));
        System.out.println("Result: " + d);

        System.out.println("== Idempotency: same key twice returns the same txn");
        PaymentResult e1 = c.handle(GatewayType.RAZORPAY, new PaymentRequest("k4", "A", "B", 1000, "INR"));
        PaymentResult e2 = c.handle(GatewayType.RAZORPAY, new PaymentRequest("k4", "A", "B", 1000, "INR"));
        check("same txnId", e1.txnId().equals(e2.txnId()));

        System.out.println("== Invalid inputs");
        check("zero amount", c.handle(GatewayType.RAZORPAY, new PaymentRequest("k5", "A", "B", 0, "INR")).status() == Status.VALIDATION_FAILED);
        check("self-payment", c.handle(GatewayType.RAZORPAY, new PaymentRequest("k6", "A", "A", 100, "INR")).status() == Status.VALIDATION_FAILED);

        System.out.println("== Concurrency: 50 parallel payments, shared service");
        ExecutorService pool = Executors.newFixedThreadPool(8);
        List<Future<PaymentResult>> fs = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            final int n = i;
            fs.add(pool.submit(() -> c.handle(n % 2 == 0 ? GatewayType.PAYTM : GatewayType.RAZORPAY,
                    new PaymentRequest("p" + n, "U" + n, "M", 100, "INR"))));
        }
        int ok = 0;
        for (Future<PaymentResult> f : fs) if (f.get().ok()) ok++;
        pool.shutdown();
        System.out.println("  " + ok + "/50 succeeded (simulated bank is probabilistic)");
        check("no crashes / all results returned", fs.size() == 50);

        System.out.println(failures == 0 ? "\nALL CHECKS PASSED" : "\n" + failures + " CHECK(S) FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }
}
