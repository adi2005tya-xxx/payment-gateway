// C++17 port of the improved gateway. Fixes vs. the original:
//  - no raw new/delete: unique_ptr/shared_ptr ownership, PaymentRequest is a value type
//  - money in integer paise
//  - proxy retries only DECLINED (transient), never VALIDATION_FAILED
//  - idempotency key, mutex-protected service, no shared mutable "current gateway"
//  - rand() replaced by mt19937 behind a mutex; "receiver" typo fixed; comments match behaviour
#include <cstdio>
#include <iostream>
#include <memory>
#include <mutex>
#include <random>
#include <string>
#include <unordered_map>

enum class Status { SUCCESS, VALIDATION_FAILED, DECLINED, CONFIRMATION_FAILED };
enum class GatewayType { PAYTM, RAZORPAY };

struct PaymentRequest {
    std::string idempotencyKey, sender, receiver;
    long long amountPaise;
    std::string currency;
};

struct PaymentResult {
    Status status;
    std::string txnId, message;
    bool ok() const { return status == Status::SUCCESS; }
    bool retryable() const { return status == Status::DECLINED; }
};

static std::string fmtMoney(long long paise, const std::string& cur) {
    char buf[64];
    std::snprintf(buf, sizeof buf, "%lld.%02lld", paise / 100, paise % 100);
    return std::string(buf) + " " + cur;
}

// ---- Strategy ----
class BankingSystem {
public:
    virtual bool charge(long long amountPaise) = 0;
    virtual ~BankingSystem() = default;
};

class SimulatedBank : public BankingSystem {
    int successPercent_;
    std::mt19937 rng_;
    std::mutex m_;
public:
    SimulatedBank(int pct, unsigned seed) : successPercent_(pct), rng_(seed) {}
    bool charge(long long amountPaise) override {
        std::lock_guard<std::mutex> lk(m_);
        std::cout << "[Bank " << successPercent_ << "%] processing " << fmtMoney(amountPaise, "") << "\n";
        return std::uniform_int_distribution<int>(0, 99)(rng_) < successPercent_;
    }
};

// ---- Template Method ----
class PaymentGateway {
protected:
    std::string name_;
    std::shared_ptr<BankingSystem> bank_;
    static int nextSeq() { static int s = 0; static std::mutex m; std::lock_guard<std::mutex> l(m); return ++s; }
public:
    PaymentGateway(std::string name, std::shared_ptr<BankingSystem> bank)
        : name_(std::move(name)), bank_(std::move(bank)) {}
    virtual ~PaymentGateway() = default;

    virtual PaymentResult process(const PaymentRequest& r) {
        std::string txn = name_ + "-" + std::to_string(nextSeq());
        if (!validate(r)) return {Status::VALIDATION_FAILED, txn, "validation failed"};
        std::cout << "[" << name_ << "] charging " << fmtMoney(r.amountPaise, r.currency) << " for " << r.sender << "\n";
        if (!bank_->charge(r.amountPaise)) return {Status::DECLINED, txn, "bank declined"};
        if (!confirm(r)) return {Status::CONFIRMATION_FAILED, txn, "confirmation failed"};
        return {Status::SUCCESS, txn, "ok"};
    }
protected:
    virtual bool validate(const PaymentRequest& r) {
        return r.amountPaise > 0 && !r.sender.empty() && !r.receiver.empty() && r.sender != r.receiver;
    }
    virtual bool confirm(const PaymentRequest&) { return true; }
};

class PaytmGateway : public PaymentGateway {
public:
    explicit PaytmGateway(std::shared_ptr<BankingSystem> b) : PaymentGateway("Paytm", std::move(b)) {}
protected:
    bool validate(const PaymentRequest& r) override { return PaymentGateway::validate(r) && r.currency == "INR"; }
};

class RazorpayGateway : public PaymentGateway {
public:
    explicit RazorpayGateway(std::shared_ptr<BankingSystem> b) : PaymentGateway("Razorpay", std::move(b)) {}
};

// ---- Proxy: owns the real gateway via unique_ptr (no manual delete) ----
class RetryingGateway : public PaymentGateway {
    std::unique_ptr<PaymentGateway> real_;
    int maxAttempts_;
public:
    RetryingGateway(std::unique_ptr<PaymentGateway> real, int maxAttempts)
        : PaymentGateway("Proxy", nullptr), real_(std::move(real)), maxAttempts_(maxAttempts) {}

    PaymentResult process(const PaymentRequest& r) override {
        PaymentResult res{};
        for (int a = 1; a <= maxAttempts_; ++a) {
            if (a > 1) std::cout << "[Proxy] retry " << a << "/" << maxAttempts_ << " for " << r.sender << "\n";
            res = real_->process(r);
            if (res.ok() || !res.retryable()) return res;
        }
        std::cout << "[Proxy] failed after " << maxAttempts_ << " attempts for " << r.sender << "\n";
        return res;
    }
};

// ---- Factory (Meyers singleton: thread-safe init, no static-init-order problems) ----
class GatewayFactory {
    std::shared_ptr<BankingSystem> paytmBank_ = std::make_shared<SimulatedBank>(80, std::random_device{}());
    std::shared_ptr<BankingSystem> razorpayBank_ = std::make_shared<SimulatedBank>(90, std::random_device{}());
    GatewayFactory() = default;
public:
    GatewayFactory(const GatewayFactory&) = delete;
    GatewayFactory& operator=(const GatewayFactory&) = delete;
    static GatewayFactory& instance() { static GatewayFactory f; return f; }

    std::unique_ptr<PaymentGateway> create(GatewayType t) {
        if (t == GatewayType::PAYTM)
            return std::make_unique<RetryingGateway>(std::make_unique<PaytmGateway>(paytmBank_), 3);
        return std::make_unique<RetryingGateway>(std::make_unique<RazorpayGateway>(razorpayBank_), 1);
    }
};

// ---- Service: idempotent; takes the gateway per call, so no shared mutable gateway ----
class PaymentService {
    std::mutex m_;
    std::unordered_map<std::string, PaymentResult> done_;
    PaymentService() = default;
public:
    PaymentService(const PaymentService&) = delete;
    PaymentService& operator=(const PaymentService&) = delete;
    static PaymentService& instance() { static PaymentService s; return s; }

    PaymentResult process(PaymentGateway& gw, const PaymentRequest& r) {
        // Lock held across the charge so duplicate keys cannot both charge.
        std::lock_guard<std::mutex> lk(m_);
        auto it = done_.find(r.idempotencyKey);
        if (it != done_.end()) return it->second;
        return done_[r.idempotencyKey] = gw.process(r);
    }
};

class PaymentController {
    PaymentController() = default;
public:
    static PaymentController& instance() { static PaymentController c; return c; }
    PaymentResult handle(GatewayType t, const PaymentRequest& r) {
        auto gw = GatewayFactory::instance().create(t);
        return PaymentService::instance().process(*gw, r);
    }
};

static int failures = 0;
static void check(const char* label, bool cond) {
    std::cout << (cond ? "  PASS " : "  FAIL ") << label << "\n";
    if (!cond) ++failures;
}

int main() {
    auto& c = PaymentController::instance();

    auto a = c.handle(GatewayType::PAYTM, {"k1", "Aditya", "Shubham", 100000, "INR"});
    std::cout << "Paytm INR: " << a.message << " " << a.txnId << "\n";

    auto b = c.handle(GatewayType::PAYTM, {"k2", "Shubham", "Aditya", 50000, "USD"});
    check("USD rejected by Paytm without retry", b.status == Status::VALIDATION_FAILED);

    auto d = c.handle(GatewayType::RAZORPAY, {"k3", "Shubham", "Aditya", 50000, "USD"});
    std::cout << "Razorpay USD: " << d.message << " " << d.txnId << "\n";

    auto e1 = c.handle(GatewayType::RAZORPAY, {"k4", "A", "B", 1000, "INR"});
    auto e2 = c.handle(GatewayType::RAZORPAY, {"k4", "A", "B", 1000, "INR"});
    check("idempotent: same txnId", e1.txnId == e2.txnId);

    check("zero amount rejected", c.handle(GatewayType::RAZORPAY, {"k5", "A", "B", 0, "INR"}).status == Status::VALIDATION_FAILED);
    check("self-payment rejected", c.handle(GatewayType::RAZORPAY, {"k6", "A", "A", 100, "INR"}).status == Status::VALIDATION_FAILED);

    std::cout << (failures ? "SOME CHECKS FAILED\n" : "ALL CHECKS PASSED\n");
    return failures ? 1 : 0;
}
