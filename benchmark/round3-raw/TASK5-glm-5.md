# Round 3 TASK5 — Translation (中英日三语翻译) 原始答案

## glm-5
**耗时: 11758ms**

1. **English Version**
"In Event-Driven Architecture (EDA), the CQRS pattern separates read and write operations into different models for processing. The Command Side records all state changes via Event Sourcing, while the Query Side maintains Materialized Views to optimize read performance. Eventual Consistency is a core characteristic of this architecture—after a write is confirmed, the read side may require a delay ranging from milliseconds to seconds to reflect the latest state. Compensating Transactions are used to handle business rollbacks in distributed scenarios."

2. **Japanese Version**
"イベント駆動アーキテクチャ（EDA）において、CQRSパターンは読み取り操作と書き込み操作を異なるモデルに分離して処理します。コマンドサイド（Command Side）はイベントソーシング（Event Sourcing）を通じてすべての状態変更を記録し、クエリサイド（Query Side）は読み取りパフォーマンスを最適化するためにマテリアライズドビュー（Materialized View）を維持管理します。結果整合性（Eventual Consistency）はこのアーキテクチャの中核的な特徴です。書き込みが確認された後、読み取り側が最新の状態を反映するまでには、数ミリ秒から数秒の遅延が生じる可能性があります。補償トランザクション（Compensating Transaction）は、分散環境下でのビジネスロールバックを処理するために使用されます。"

3. **Chinese Back-Translation (from English)**
"在事件驱动架构（EDA）中，CQRS 模式将读写操作分离到不同的模型中进行处理。命令端（Command Side）通过事件溯源（Event Sourcing）记录所有状态变更，而查询端（Query Side）则维护物化视图（Materialized View）以优化读取性能。最终一致性（Eventual Consistency）是这种架构的核心特征——写入确认后，读取端可能需要数毫秒到数秒的延迟才能反映最新状态。补偿事务（Compensating Transaction）用于处理分布式场景下的业务回滚。"
