# Round 3 TASK5 — Translation (中英日三语翻译) 原始答案

## MiniMax-M2.7
**耗时: 23777ms**

**1. 英文版**
In an event‑driven architecture (EDA), the CQRS pattern separates read and write operations into different models. The command side records all state changes through event sourcing, while the query side maintains a materialized view to optimize read performance. Eventual consistency is a core characteristic of this architecture—after a write is acknowledged, the read side may need a delay ranging from a few milliseconds to several seconds to reflect the latest state. Compensating transactions are used to handle business rollbacks in distributed scenarios.

**2. 日文版**
イベント駆動アーキテクチャ（EDA）において、CQRSパターンは読み取りと書き込みの操作を異なるモデルに分離します。コマンド側はイベントソース（Event Sourcing）によってすべての状態変更を記録し、クエリ側は読み取りパフォーマンスを最適化するためにマテリアライズドビュー（Materialized View）を維持します。最終整合性（Eventual Consistency）はこのアーキテクチャの中核的な特性であり、書き込みが肯定された後、読み取り側は最新の状態を反映するために数ミリ秒から数秒の遅延を必要とする場合があります。補償トランザクション（Compensating Transaction）は、分散シナリオにおけるビジネスロールバックを処理するために使用されます。

**3. 英文版回译为中文版**
在事件驱动架构（EDA）中，CQRS 模式将读取和写入操作分离到不同的模型中处理。命令端通过事件溯源（Event Sourcing）记录所有状态变更，而查询端则维护物化视图（Materialized View）以优化读取性能。最终一致性（Eventual Consistency）是该架构的核心特征——在写入确认后，读取端可能需要从几毫秒到几秒的延迟才能反映最新状态。补偿事务（Compensating Transaction）用于处理分布式场景下的业务回滚。
